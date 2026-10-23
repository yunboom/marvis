package landiscovery

import (
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
	"github.com/pkg/errors"
	"golang.org/x/net/ipv4"
)

const (
	// mdnsPort 是 mDNS 的 UDP 端口，应答必须从这个端口发出（RFC 6762 第 11 节）。
	mdnsPort = 5353
	// mdnsIPTTL 是 mDNS 组播报文的 IP TTL（RFC 6762 第 11 节）。
	mdnsIPTTL = 255
	// hostRecordTTL 是与主机名相关的记录（A、SRV、NSEC）的 TTL，单位秒（RFC 6762 第 10 节）。
	hostRecordTTL = 120
	// serviceRecordTTL 是其余记录（PTR、TXT）的 TTL，单位秒（RFC 6762 第 10 节）。
	serviceRecordTTL = 4500
	// legacyUnicastTTL 是回给非 5353 端口查询方的记录 TTL 上限，单位秒（RFC 6762 第 6.7 节）。
	legacyUnicastTTL = 10
	// classCacheFlush 是应答记录 class 字段的最高位：唯一记录带上它，接收方据此替换缓存里的旧值。
	classCacheFlush = 1 << 15
	// classUnicastResponse 是问题 class 字段的最高位，表示查询方希望单播应答。
	classUnicastResponse = 1 << 15
	// servicesEnumName 是 DNS-SD 枚举服务类型的名字（RFC 6763 第 9 节）。
	servicesEnumName = "_services._dns-sd._udp." + Domain
	// announceCount 是启动时宣告的次数，相邻两次的间隔从 announceInterval 起每次翻倍（RFC 6762 第 8.3 节）。
	announceCount = 2
	// announceInterval 是首次宣告与第二次宣告的间隔。
	announceInterval = time.Second
	// maxPacketBytes 是 mDNS 报文的大小上限（RFC 6762 第 17 节），也是接收缓冲区的大小。
	maxPacketBytes = 9000
	// readRetryDelay 是读套接字出现非关闭错误后的等待时间，避免空转。
	readRetryDelay = 100 * time.Millisecond
)

var (
	// mdnsGroupIPv4 是 mDNS 的 IPv4 组播地址。
	mdnsGroupIPv4 = net.IPv4(224, 0, 0, 251)
	// mdnsGroupAddr 是组播应答和宣告的目的地址。
	mdnsGroupAddr = &net.UDPAddr{IP: mdnsGroupIPv4, Port: mdnsPort}
)

// serviceRecords 是一台服务器在 mDNS 上拥有的名字和记录内容，与网卡无关；
// A 记录的地址按收到查询的网卡分别填写，每块网卡只报自己的地址。
type serviceRecords struct {
	// service 是服务类型全名，如 _marvis._tcp.local.。
	service string
	// instance 是实例全名，标签部分已按 DNS 规则转义。
	instance string
	// host 是主机名全名，如 marvis.local.。
	host string
	// port 是服务端口。
	port uint16
	// txt 是打包前的 TXT 字符串，反斜杠已转义。
	txt []string
}

// newServiceRecords 按广播配置和选定的主机名（不带后缀，如 marvis-2）生成记录。
// cfg.Port 必须已校验在 1~65535 之间。
func newServiceRecords(cfg Config, host, serverVersion, instanceID string) serviceRecords {
	service := ServiceType + "." + Domain

	return serviceRecords{
		service:  service,
		instance: instanceLabel(cfg.Name) + "." + service,
		host:     host + hostSuffix + ".",
		port:     uint16(cfg.Port),
		txt:      wireTXT(TXTRecords(cfg.Name, serverVersion, instanceID)),
	}
}

// answer 构造对一条查询的应答，ips 是收到查询的网卡上的 IPv4。
// 只回答本服务器拥有的名字；查询方在已知答案里带了同样的记录且 TTL 还剩一半以上时不重复应答。
// 没有要回答的内容时返回 nil。legacy 为 true 表示查询来自非 5353 端口（如 dig），
// 按 RFC 6762 第 6.7 节回传查询 ID 和问题，记录不带缓存刷新位，TTL 不超过 legacyUnicastTTL。
func (r serviceRecords) answer(query *dns.Msg, ips []net.IP, legacy bool) *dns.Msg {
	if query.Response || query.Opcode != dns.OpcodeQuery {
		return nil
	}

	var answers, extras []dns.RR
	for _, q := range query.Question {
		questionAnswers, questionExtras := r.answerQuestion(q, ips)
		answers = append(answers, questionAnswers...)
		extras = append(extras, questionExtras...)
	}

	answers = withoutKnown(answers, query.Answer)
	if len(answers) == 0 {
		return nil
	}

	resp := newResponse()
	resp.Answer = uniqueRecords(answers, nil)
	resp.Extra = uniqueRecords(extras, resp.Answer)

	if legacy {
		resp.Id = query.Id
		resp.Question = query.Question

		for _, rr := range append(append([]dns.RR{}, resp.Answer...), resp.Extra...) {
			hdr := rr.Header()
			hdr.Class &^= classCacheFlush
			hdr.Ttl = min(hdr.Ttl, legacyUnicastTTL)
		}
	}

	return resp
}

// answerQuestion 返回一个问题的应答记录和附加记录，名字比较忽略大小写。
func (r serviceRecords) answerQuestion(q dns.Question, ips []net.IP) ([]dns.RR, []dns.RR) {
	if class := q.Qclass &^ classUnicastResponse; class != dns.ClassINET && class != dns.ClassANY {
		return nil, nil
	}

	switch {
	case strings.EqualFold(q.Name, servicesEnumName):
		if matchesType(q.Qtype, dns.TypePTR) {
			return []dns.RR{r.enumPTR()}, nil
		}
	case strings.EqualFold(q.Name, r.service):
		if matchesType(q.Qtype, dns.TypePTR) {
			return []dns.RR{r.servicePTR()}, append([]dns.RR{r.srv(), r.txtRecord()}, r.hostRecords(ips)...)
		}
	case strings.EqualFold(q.Name, r.instance):
		return r.answerInstance(q.Qtype, ips)
	case strings.EqualFold(q.Name, r.host):
		return r.answerHost(q.Qtype, ips)
	}

	return nil, nil
}

// answerInstance 回答实例名上的 SRV / TXT 查询，附带主机地址。
func (r serviceRecords) answerInstance(qtype uint16, ips []net.IP) ([]dns.RR, []dns.RR) {
	var answers []dns.RR

	if matchesType(qtype, dns.TypeSRV) {
		answers = append(answers, r.srv())
	}

	if matchesType(qtype, dns.TypeTXT) {
		answers = append(answers, r.txtRecord())
	}

	if len(answers) == 0 {
		return nil, nil
	}

	return answers, r.hostRecords(ips)
}

// answerHost 回答主机名查询：A 给出本网卡的地址，其他类型（主要是 AAAA）用 NSEC 声明不存在，
// 让解析方立即拿到结果，不必等 IPv6 查询超时。本网卡没有地址时不回答。
func (r serviceRecords) answerHost(qtype uint16, ips []net.IP) ([]dns.RR, []dns.RR) {
	if len(ips) == 0 {
		return nil, nil
	}

	switch qtype {
	case dns.TypeA:
		return r.aRecords(ips), []dns.RR{r.hostNSEC()}
	case dns.TypeANY:
		return append(r.aRecords(ips), r.hostNSEC()), nil
	default:
		return []dns.RR{r.hostNSEC()}, r.aRecords(ips)
	}
}

// announcement 构造宣告报文，全部记录放在应答区；goodbye 为 true 时 TTL 全部为 0，通知各方删除缓存。
func (r serviceRecords) announcement(ips []net.IP, goodbye bool) *dns.Msg {
	msg := newResponse()
	msg.Answer = append([]dns.RR{r.servicePTR(), r.enumPTR(), r.srv(), r.txtRecord()}, r.hostRecords(ips)...)

	if goodbye {
		for _, rr := range msg.Answer {
			rr.Header().Ttl = 0
		}
	}

	return msg
}

// hostRecords 返回主机名的 A 记录和声明没有其他类型的 NSEC 记录。
func (r serviceRecords) hostRecords(ips []net.IP) []dns.RR {
	if len(ips) == 0 {
		return nil
	}

	return append(r.aRecords(ips), r.hostNSEC())
}

func (r serviceRecords) aRecords(ips []net.IP) []dns.RR {
	records := make([]dns.RR, 0, len(ips))
	for _, ip := range ips {
		records = append(records, &dns.A{Hdr: recordHeader(r.host, dns.TypeA, hostRecordTTL, true), A: ip})
	}

	return records
}

func (r serviceRecords) hostNSEC() dns.RR {
	return &dns.NSEC{
		Hdr:        recordHeader(r.host, dns.TypeNSEC, hostRecordTTL, true),
		NextDomain: r.host,
		TypeBitMap: []uint16{dns.TypeA},
	}
}

func (r serviceRecords) servicePTR() dns.RR {
	return &dns.PTR{Hdr: recordHeader(r.service, dns.TypePTR, serviceRecordTTL, false), Ptr: r.instance}
}

func (r serviceRecords) enumPTR() dns.RR {
	return &dns.PTR{Hdr: recordHeader(servicesEnumName, dns.TypePTR, serviceRecordTTL, false), Ptr: r.service}
}

func (r serviceRecords) srv() dns.RR {
	return &dns.SRV{Hdr: recordHeader(r.instance, dns.TypeSRV, hostRecordTTL, true), Port: r.port, Target: r.host}
}

func (r serviceRecords) txtRecord() dns.RR {
	return &dns.TXT{Hdr: recordHeader(r.instance, dns.TypeTXT, serviceRecordTTL, true), Txt: r.txt}
}

// recordHeader 生成记录头。unique 表示记录只由本机拥有（SRV、TXT、A、NSEC），带缓存刷新位；
// PTR 是多台服务器共享的记录，不带。
func recordHeader(name string, rrtype uint16, ttl uint32, unique bool) dns.RR_Header {
	class := uint16(dns.ClassINET)
	if unique {
		class |= classCacheFlush
	}

	return dns.RR_Header{Name: name, Rrtype: rrtype, Class: class, Ttl: ttl}
}

// newResponse 返回一条空的权威应答。组播应答的 ID 为 0，不带问题区（RFC 6762 第 18 节）。
func newResponse() *dns.Msg {
	msg := new(dns.Msg)
	msg.Response = true
	msg.Authoritative = true
	msg.Compress = true

	return msg
}

// matchesType 判断问题类型是否要求 want 类型的记录。
func matchesType(qtype, want uint16) bool {
	return qtype == want || qtype == dns.TypeANY
}

// withoutKnown 去掉查询方已知的应答（RFC 6762 第 7.1 节）：已知记录的 TTL 不到一半时仍然应答，让对方刷新。
func withoutKnown(answers, known []dns.RR) []dns.RR {
	kept := answers[:0]

	for _, rr := range answers {
		if !isKnownAnswer(rr, known) {
			kept = append(kept, rr)
		}
	}

	return kept
}

func isKnownAnswer(rr dns.RR, known []dns.RR) bool {
	for _, k := range known {
		if k.Header().Ttl >= rr.Header().Ttl/2 && sameRecord(rr, k) {
			return true
		}
	}

	return false
}

// uniqueRecords 去掉重复的记录以及已在 exclude 中出现的记录，保持原有顺序。
func uniqueRecords(records, exclude []dns.RR) []dns.RR {
	var out []dns.RR

	for _, rr := range records {
		if containsRecord(exclude, rr) || containsRecord(out, rr) {
			continue
		}

		out = append(out, rr)
	}

	return out
}

func containsRecord(records []dns.RR, target dns.RR) bool {
	for _, rr := range records {
		if sameRecord(rr, target) {
			return true
		}
	}

	return false
}

// sameRecord 判断两条记录的名字、类型和内容是否相同，忽略 TTL 和缓存刷新位。
func sameRecord(a, b dns.RR) bool {
	left, right := dns.Copy(a), dns.Copy(b)
	left.Header().Class &^= classCacheFlush
	right.Header().Class &^= classCacheFlush

	return dns.IsDuplicate(left, right)
}

// replyFor 解析收到的报文并决定应答内容和目的地址：来自 5353 端口的查询以组播应答，
// 来自其他端口的（传统单播查询）直接回给发送方。收到报文的网卡不在广播范围内、
// 报文解析失败或没有要回答的内容时返回 nil。
//
// 查询方希望单播应答（问题 class 带 QU 位）时也以组播应答：同一台电脑上的系统 mDNS 服务和本进程
// 共用 5353 端口，发往本机 5353 端口的单播只会交给其中一个套接字，组播则每个套接字都能收到。
func replyFor(records serviceRecords, addrs map[int][]net.IP, packet []byte, ifIndex int, src *net.UDPAddr) (*dns.Msg, *net.UDPAddr) {
	ips, ok := addrs[ifIndex]
	if !ok {
		return nil, nil
	}

	// 局域网里任何设备都能发来报文，解析不了的直接丢弃，与其他 mDNS 实现的做法一致。
	var query dns.Msg
	if err := query.Unpack(packet); err != nil {
		return nil, nil
	}

	legacy := src.Port != mdnsPort

	resp := records.answer(&query, ips, legacy)
	if resp == nil {
		return nil, nil
	}

	if legacy {
		return resp, src
	}

	return resp, mdnsGroupAddr
}

// lanIface 是一块可广播的网卡和它上面的局域网地址。
type lanIface struct {
	iface net.Interface
	ips   []net.IP
}

// responder 是运行中的 mDNS 应答器：在每块局域网网卡上应答服务和主机名查询，启动时宣告，停止时撤销。
type responder struct {
	records serviceRecords
	// addrs 是网卡序号到该网卡局域网地址的映射，也决定了应答哪些网卡上收到的查询。
	addrs map[int][]net.IP
	conn  *ipv4.PacketConn

	stop         chan struct{}
	announceDone chan struct{}
	serveDone    chan struct{}
	stopOnce     sync.Once
}

// startResponder 加入各网卡的 mDNS 组播组并开始应答。
// 监听地址写组播地址时，Go 会绑定 0.0.0.0:5353 并设置 SO_REUSEADDR / SO_REUSEPORT，
// 与系统自带的 mDNS 服务（macOS 的 mDNSResponder、Linux 的 avahi）共用端口。
func startResponder(records serviceRecords, ifaces []lanIface) (*responder, error) {
	udpConn, err := net.ListenUDP("udp4", mdnsGroupAddr)
	if err != nil {
		return nil, errors.Wrapf(err, "listen mdns port=%d", mdnsPort)
	}

	conn := ipv4.NewPacketConn(udpConn)

	addrs, err := joinGroups(conn, ifaces)
	if err == nil {
		err = configureConn(conn)
	}
	if err != nil {
		_ = conn.Close()

		return nil, err
	}

	r := &responder{
		records:      records,
		addrs:        addrs,
		conn:         conn,
		stop:         make(chan struct{}),
		announceDone: make(chan struct{}),
		serveDone:    make(chan struct{}),
	}

	go r.serve()
	go r.announce()

	return r, nil
}

// joinGroups 在每块网卡上加入 mDNS 组播组。个别网卡加入失败时记警告并跳过，
// 广播仍在其他网卡上进行；全部失败时返回错误。
func joinGroups(conn *ipv4.PacketConn, ifaces []lanIface) (map[int][]net.IP, error) {
	addrs := make(map[int][]net.IP, len(ifaces))

	var lastErr error
	for _, li := range ifaces {
		if err := conn.JoinGroup(&li.iface, &net.UDPAddr{IP: mdnsGroupIPv4}); err != nil {
			lastErr = errors.Wrapf(err, "join mdns group interface=%s", li.iface.Name)
			slog.Warn("lan discovery: skipping interface", "interface", li.iface.Name, "error", lastErr)

			continue
		}

		addrs[li.iface.Index] = li.ips
	}

	if len(addrs) == 0 {
		if lastErr == nil {
			return nil, errNoLANAddress
		}

		return nil, lastErr
	}

	return addrs, nil
}

// configureConn 打开收包网卡信息并设置组播 TTL。收包网卡决定应答里填哪块网卡的地址。
func configureConn(conn *ipv4.PacketConn) error {
	if err := conn.SetControlMessage(ipv4.FlagInterface, true); err != nil {
		return errors.Wrap(err, "enable mdns interface control messages")
	}

	if err := conn.SetMulticastTTL(mdnsIPTTL); err != nil {
		return errors.Wrap(err, "set mdns multicast ttl")
	}

	return nil
}

// serve 持续读取查询并应答，套接字关闭后返回。
func (r *responder) serve() {
	defer close(r.serveDone)

	buf := make([]byte, maxPacketBytes)

	for {
		n, cm, src, err := r.conn.ReadFrom(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}

			slog.Warn("lan discovery: read mdns packet failed", "error", errors.WithStack(err))

			if r.wait(readRetryDelay) {
				return
			}

			continue
		}

		udpSrc, ok := src.(*net.UDPAddr)
		if cm == nil || !ok {
			continue
		}

		resp, dst := replyFor(r.records, r.addrs, buf[:n], cm.IfIndex, udpSrc)
		if resp == nil {
			continue
		}

		if err := r.send(resp, cm.IfIndex, dst); err != nil {
			slog.Warn("lan discovery: send mdns response failed", "error", err)
		}
	}
}

// announce 启动后宣告 announceCount 次，间隔从 announceInterval 起每次翻倍。
func (r *responder) announce() {
	defer close(r.announceDone)

	interval := announceInterval

	for i := range announceCount {
		r.broadcast(false)

		if i == announceCount-1 || r.wait(interval) {
			return
		}

		interval *= 2
	}
}

// wait 等待 d，期间收到停止信号时返回 true。
func (r *responder) wait(d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()

	select {
	case <-r.stop:
		return true
	case <-timer.C:
		return false
	}
}

// broadcast 在每块网卡上组播一次全部记录，地址取该网卡自己的。
func (r *responder) broadcast(goodbye bool) {
	// 每块网卡的报文内容和出口都不同，只能逐块发送；发送是本机套接字写入，不经过网络往返。
	for ifIndex, ips := range r.addrs {
		if err := r.send(r.records.announcement(ips, goodbye), ifIndex, mdnsGroupAddr); err != nil {
			slog.Warn("lan discovery: send mdns announcement failed", "goodbye", goodbye, "error", err)
		}
	}
}

// send 从 ifIndex 网卡把报文发往 dst。
func (r *responder) send(msg *dns.Msg, ifIndex int, dst *net.UDPAddr) error {
	packet, err := msg.Pack()
	if err != nil {
		return errors.Wrapf(err, "pack mdns message if_index=%d", ifIndex)
	}

	if _, err := r.conn.WriteTo(packet, &ipv4.ControlMessage{IfIndex: ifIndex}, dst); err != nil {
		return errors.Wrapf(err, "send mdns message if_index=%d dst=%s", ifIndex, dst)
	}

	return nil
}

// Stop 停止宣告，发出撤销报文后关闭套接字，可重复调用。
func (r *responder) Stop() {
	r.stopOnce.Do(func() {
		close(r.stop)

		// 等宣告协程结束再撤销，避免撤销之后又有一次宣告把记录写回各方缓存。
		<-r.announceDone
		r.broadcast(true)

		// 关闭后读协程从 ReadFrom 返回 net.ErrClosed 并退出；关闭失败时套接字已不可用，无需处理。
		_ = r.conn.Close()
		<-r.serveDone
	})
}
