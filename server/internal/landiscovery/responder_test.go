package landiscovery

import (
	"net"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/miekg/dns"
)

const (
	testHost    = "marvis.local."
	testService = "_marvis._tcp.local."
	testIfIndex = 4
)

// testInstance 是“设计部 Marvis”的实例全名，中文按 DNS 规则写成十进制转义，与解包后的写法一致。
var testInstance = instanceLabel("设计部 Marvis") + "." + testService

// testRecords 返回测试用的一组广播记录：名称含中文和空格，主机名 marvis。
func testRecords() serviceRecords {
	return newServiceRecords(Config{Name: "设计部 Marvis", Port: 13840}, DefaultHostname, "v0.6.5", "7f3a")
}

// testIPs 是收到查询的网卡上的地址。
func testIPs() []net.IP {
	return []net.IP{net.ParseIP("192.168.1.20").To4()}
}

// query 构造一条包含给定问题的组播查询。
func query(questions ...dns.Question) *dns.Msg {
	msg := new(dns.Msg)
	msg.Question = questions

	return msg
}

func question(name string, qtype uint16) dns.Question {
	return dns.Question{Name: name, Qtype: qtype, Qclass: dns.ClassINET}
}

// rrSummary 把记录压成“名字 类型 内容”的可读形式，便于整体比较；名字统一小写。
func rrSummary(records []dns.RR) []string {
	out := make([]string, 0, len(records))

	for _, rr := range records {
		hdr := rr.Header()

		var data string
		switch v := rr.(type) {
		case *dns.A:
			data = v.A.String()
		case *dns.PTR:
			data = v.Ptr
		case *dns.SRV:
			data = v.Target + ":" + strconv.Itoa(int(v.Port))
		case *dns.TXT:
			var txt []string
			for _, raw := range v.Txt {
				txt = append(txt, unescapeDNS(raw))
			}
			data = strings.Join(txt, ",")
		case *dns.NSEC:
			var types []string
			for _, t := range v.TypeBitMap {
				types = append(types, dns.TypeToString[t])
			}
			data = v.NextDomain + " " + strings.Join(types, ",")
		default:
			data = rr.String()
		}

		out = append(out, strings.ToLower(hdr.Name)+" "+dns.TypeToString[hdr.Rrtype]+" "+data)
	}

	return out
}

func TestAnswerHostA(t *testing.T) {
	resp := testRecords().answer(query(question(testHost, dns.TypeA)), testIPs(), false)
	if resp == nil {
		t.Fatal("answer() = nil, want an A answer")
	}

	if got, want := rrSummary(resp.Answer), []string{"marvis.local. A 192.168.1.20"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("answers = %v, want %v", got, want)
	}
	// 附加区用 NSEC 声明没有 AAAA，解析方不必再等 IPv6 的结果。
	if got, want := rrSummary(resp.Extra), []string{"marvis.local. NSEC marvis.local. A"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("extras = %v, want %v", got, want)
	}

	a := resp.Answer[0].Header()
	if a.Ttl != hostRecordTTL || a.Class != dns.ClassINET|classCacheFlush {
		t.Fatalf("A header ttl=%d class=%#x, want ttl=%d class=%#x", a.Ttl, a.Class, hostRecordTTL, dns.ClassINET|classCacheFlush)
	}
	if !resp.Response || !resp.Authoritative || resp.Id != 0 || len(resp.Question) != 0 {
		t.Fatalf("header response=%v aa=%v id=%d questions=%d, want a multicast response without questions",
			resp.Response, resp.Authoritative, resp.Id, len(resp.Question))
	}
}

func TestAnswerHostNameIsCaseInsensitive(t *testing.T) {
	resp := testRecords().answer(query(question("MARVIS.Local.", dns.TypeA)), testIPs(), false)
	if resp == nil || len(resp.Answer) != 1 {
		t.Fatalf("answer() = %v, want one A record", resp)
	}
}

func TestAnswerHostAAAAIsNSEC(t *testing.T) {
	resp := testRecords().answer(query(question(testHost, dns.TypeAAAA)), testIPs(), false)
	if resp == nil {
		t.Fatal("answer() = nil, want an NSEC answer")
	}

	if got, want := rrSummary(resp.Answer), []string{"marvis.local. NSEC marvis.local. A"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("answers = %v, want %v", got, want)
	}
	if got, want := rrSummary(resp.Extra), []string{"marvis.local. A 192.168.1.20"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("extras = %v, want %v", got, want)
	}
	if nsec := resp.Answer[0].Header(); nsec.Ttl != hostRecordTTL || nsec.Class != dns.ClassINET|classCacheFlush {
		t.Fatalf("NSEC header ttl=%d class=%#x", nsec.Ttl, nsec.Class)
	}
}

func TestAnswerHostAny(t *testing.T) {
	resp := testRecords().answer(query(question(testHost, dns.TypeANY)), testIPs(), false)
	if resp == nil {
		t.Fatal("answer() = nil")
	}

	want := []string{"marvis.local. A 192.168.1.20", "marvis.local. NSEC marvis.local. A"}
	if got := rrSummary(resp.Answer); !reflect.DeepEqual(got, want) {
		t.Fatalf("answers = %v, want %v", got, want)
	}
}

func TestAnswerHostWithSeveralAddresses(t *testing.T) {
	ips := []net.IP{net.ParseIP("192.168.1.20").To4(), net.ParseIP("10.0.0.5").To4()}

	resp := testRecords().answer(query(question(testHost, dns.TypeA)), ips, false)
	want := []string{"marvis.local. A 192.168.1.20", "marvis.local. A 10.0.0.5"}
	if got := rrSummary(resp.Answer); !reflect.DeepEqual(got, want) {
		t.Fatalf("answers = %v, want %v", got, want)
	}
}

func TestAnswerRenamedHost(t *testing.T) {
	records := newServiceRecords(Config{Name: "studio", Port: 13840}, "marvis-2", "", "7f3a")

	if resp := records.answer(query(question(testHost, dns.TypeA)), testIPs(), false); resp != nil {
		t.Fatalf("answer(marvis.local.) = %v, want nil after renaming to marvis-2", resp)
	}

	resp := records.answer(query(question("marvis-2.local.", dns.TypeA)), testIPs(), false)
	if got, want := rrSummary(resp.Answer), []string{"marvis-2.local. A 192.168.1.20"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("answers = %v, want %v", got, want)
	}
}

func TestAnswerServiceBrowse(t *testing.T) {
	resp := testRecords().answer(query(question(testService, dns.TypePTR)), testIPs(), false)
	if resp == nil {
		t.Fatal("answer() = nil, want a PTR answer")
	}

	if got, want := rrSummary(resp.Answer), []string{"_marvis._tcp.local. PTR " + testInstance}; !reflect.DeepEqual(got, want) {
		t.Fatalf("answers = %v, want %v", got, want)
	}

	wantExtra := []string{
		strings.ToLower(testInstance) + " SRV marvis.local.:13840",
		strings.ToLower(testInstance) + " TXT v=1,name=设计部 Marvis,ver=v0.6.5,id=7f3a",
		"marvis.local. A 192.168.1.20",
		"marvis.local. NSEC marvis.local. A",
	}
	if got := rrSummary(resp.Extra); !reflect.DeepEqual(got, wantExtra) {
		t.Fatalf("extras = %v, want %v", got, wantExtra)
	}

	// PTR 是共享记录，不带缓存刷新位；SRV、TXT 是唯一记录，带缓存刷新位。
	if ptr := resp.Answer[0].Header(); ptr.Class != dns.ClassINET || ptr.Ttl != serviceRecordTTL {
		t.Fatalf("PTR header ttl=%d class=%#x", ptr.Ttl, ptr.Class)
	}
	if srv := resp.Extra[0].Header(); srv.Class != dns.ClassINET|classCacheFlush || srv.Ttl != hostRecordTTL {
		t.Fatalf("SRV header ttl=%d class=%#x", srv.Ttl, srv.Class)
	}
	if txt := resp.Extra[1].Header(); txt.Class != dns.ClassINET|classCacheFlush || txt.Ttl != serviceRecordTTL {
		t.Fatalf("TXT header ttl=%d class=%#x", txt.Ttl, txt.Class)
	}
}

func TestAnswerInstanceLookup(t *testing.T) {
	tests := []struct {
		name  string
		qtype uint16
		want  []string
	}{
		{name: "srv", qtype: dns.TypeSRV, want: []string{strings.ToLower(testInstance) + " SRV marvis.local.:13840"}},
		{name: "txt", qtype: dns.TypeTXT, want: []string{strings.ToLower(testInstance) + " TXT v=1,name=设计部 Marvis,ver=v0.6.5,id=7f3a"}},
		{name: "any", qtype: dns.TypeANY, want: []string{
			strings.ToLower(testInstance) + " SRV marvis.local.:13840",
			strings.ToLower(testInstance) + " TXT v=1,name=设计部 Marvis,ver=v0.6.5,id=7f3a",
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := testRecords().answer(query(question(testInstance, tt.qtype)), testIPs(), false)
			if resp == nil {
				t.Fatal("answer() = nil")
			}
			if got := rrSummary(resp.Answer); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("answers = %v, want %v", got, tt.want)
			}

			wantExtra := []string{"marvis.local. A 192.168.1.20", "marvis.local. NSEC marvis.local. A"}
			if got := rrSummary(resp.Extra); !reflect.DeepEqual(got, wantExtra) {
				t.Fatalf("extras = %v, want %v", got, wantExtra)
			}
		})
	}
}

func TestAnswerServiceTypeEnumeration(t *testing.T) {
	resp := testRecords().answer(query(question("_services._dns-sd._udp.local.", dns.TypePTR)), testIPs(), false)
	if resp == nil {
		t.Fatal("answer() = nil")
	}

	if got, want := rrSummary(resp.Answer), []string{"_services._dns-sd._udp.local. PTR " + testService}; !reflect.DeepEqual(got, want) {
		t.Fatalf("answers = %v, want %v", got, want)
	}
}

func TestAnswerIgnoresOtherNames(t *testing.T) {
	for _, q := range []dns.Question{
		question("printer.local.", dns.TypeA),
		question("_http._tcp.local.", dns.TypePTR),
		question("other._marvis._tcp.local.", dns.TypeSRV),
		question(testService, dns.TypeA),
	} {
		if resp := testRecords().answer(query(q), testIPs(), false); resp != nil {
			t.Fatalf("answer(%s %s) = %v, want nil", q.Name, dns.TypeToString[q.Qtype], resp)
		}
	}
}

func TestAnswerIgnoresResponses(t *testing.T) {
	msg := query(question(testHost, dns.TypeA))
	msg.Response = true

	if resp := testRecords().answer(msg, testIPs(), false); resp != nil {
		t.Fatalf("answer() = %v, want nil for a response packet", resp)
	}
}

func TestAnswerWithoutAddressSkipsHostQuestions(t *testing.T) {
	if resp := testRecords().answer(query(question(testHost, dns.TypeA)), nil, false); resp != nil {
		t.Fatalf("answer() = %v, want nil without an address on the interface", resp)
	}
}

func TestAnswerCombinesQuestions(t *testing.T) {
	resp := testRecords().answer(query(question(testHost, dns.TypeA), question(testInstance, dns.TypeSRV)), testIPs(), false)
	if resp == nil {
		t.Fatal("answer() = nil")
	}

	want := []string{"marvis.local. A 192.168.1.20", strings.ToLower(testInstance) + " SRV marvis.local.:13840"}
	if got := rrSummary(resp.Answer); !reflect.DeepEqual(got, want) {
		t.Fatalf("answers = %v, want %v", got, want)
	}
	// 附加区不重复应答区已有的记录。
	if got, want := rrSummary(resp.Extra), []string{"marvis.local. NSEC marvis.local. A"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("extras = %v, want %v", got, want)
	}
}

func TestAnswerKnownAnswerSuppression(t *testing.T) {
	records := testRecords()
	known := &dns.PTR{
		Hdr: dns.RR_Header{Name: testService, Rrtype: dns.TypePTR, Class: dns.ClassINET, Ttl: serviceRecordTTL},
		Ptr: testInstance,
	}

	msg := query(question(testService, dns.TypePTR))
	msg.Answer = []dns.RR{known}
	if resp := records.answer(msg, testIPs(), false); resp != nil {
		t.Fatalf("answer() = %v, want nil when the querier already knows the answer", resp)
	}

	// 对方缓存的 TTL 不足一半时仍要应答，让它刷新缓存。
	known.Hdr.Ttl = serviceRecordTTL/2 - 1
	if resp := records.answer(msg, testIPs(), false); resp == nil {
		t.Fatal("answer() = nil, want a refresh for a stale known answer")
	}
}

func TestAnswerLegacyUnicast(t *testing.T) {
	msg := query(question(testHost, dns.TypeA))
	msg.Id = 4242

	resp := testRecords().answer(msg, testIPs(), true)
	if resp == nil {
		t.Fatal("answer() = nil")
	}

	if resp.Id != 4242 || len(resp.Question) != 1 || resp.Question[0].Name != testHost {
		t.Fatalf("legacy response id=%d questions=%v, want the query id and question echoed", resp.Id, resp.Question)
	}

	for _, rr := range append(append([]dns.RR{}, resp.Answer...), resp.Extra...) {
		hdr := rr.Header()
		if hdr.Ttl > legacyUnicastTTL || hdr.Class&classCacheFlush != 0 {
			t.Fatalf("legacy record %s ttl=%d class=%#x, want ttl <= %d without the cache-flush bit", hdr.Name, hdr.Ttl, hdr.Class, legacyUnicastTTL)
		}
	}
}

func TestAnswerSurvivesWireRoundTrip(t *testing.T) {
	resp := testRecords().answer(query(question(testService, dns.TypePTR)), testIPs(), false)

	packed, err := resp.Pack()
	if err != nil {
		t.Fatalf("pack: %v", err)
	}

	var parsed dns.Msg
	if err := parsed.Unpack(packed); err != nil {
		t.Fatalf("unpack: %v", err)
	}
	if got, want := rrSummary(parsed.Extra), rrSummary(resp.Extra); !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip extras = %v, want %v", got, want)
	}
}

func TestAnnouncement(t *testing.T) {
	records := testRecords()

	msg := records.announcement(testIPs(), false)
	want := []string{
		"_marvis._tcp.local. PTR " + testInstance,
		"_services._dns-sd._udp.local. PTR " + testService,
		strings.ToLower(testInstance) + " SRV marvis.local.:13840",
		strings.ToLower(testInstance) + " TXT v=1,name=设计部 Marvis,ver=v0.6.5,id=7f3a",
		"marvis.local. A 192.168.1.20",
		"marvis.local. NSEC marvis.local. A",
	}
	if got := rrSummary(msg.Answer); !reflect.DeepEqual(got, want) {
		t.Fatalf("announcement = %v, want %v", got, want)
	}
	if !msg.Response || !msg.Authoritative || len(msg.Question) != 0 {
		t.Fatalf("announcement header response=%v aa=%v questions=%d", msg.Response, msg.Authoritative, len(msg.Question))
	}

	goodbye := records.announcement(testIPs(), true)
	if got := rrSummary(goodbye.Answer); !reflect.DeepEqual(got, want) {
		t.Fatalf("goodbye = %v, want %v", got, want)
	}
	for _, rr := range goodbye.Answer {
		if rr.Header().Ttl != 0 {
			t.Fatalf("goodbye record %s ttl=%d, want 0", rr.Header().Name, rr.Header().Ttl)
		}
	}
}

func TestReplyRouting(t *testing.T) {
	records := testRecords()
	addrs := map[int][]net.IP{testIfIndex: testIPs()}

	packed, err := query(question(testHost, dns.TypeA)).Pack()
	if err != nil {
		t.Fatalf("pack: %v", err)
	}

	tests := []struct {
		name    string
		packet  []byte
		ifIndex int
		src     *net.UDPAddr
		wantDst string
		wantID  bool
	}{
		{name: "mdns query is answered by multicast", packet: packed, ifIndex: testIfIndex,
			src: &net.UDPAddr{IP: net.ParseIP("192.168.1.30"), Port: mdnsPort}, wantDst: "224.0.0.251:5353"},
		{name: "legacy query is answered to the sender", packet: packed, ifIndex: testIfIndex,
			src: &net.UDPAddr{IP: net.ParseIP("192.168.1.30"), Port: 53000}, wantDst: "192.168.1.30:53000", wantID: true},
		{name: "query on an unknown interface is ignored", packet: packed, ifIndex: 9,
			src: &net.UDPAddr{IP: net.ParseIP("172.17.0.2"), Port: mdnsPort}},
		{name: "malformed packet is ignored", packet: []byte{0x01, 0x02}, ifIndex: testIfIndex,
			src: &net.UDPAddr{IP: net.ParseIP("192.168.1.30"), Port: mdnsPort}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, dst := replyFor(records, addrs, tt.packet, tt.ifIndex, tt.src)
			if tt.wantDst == "" {
				if resp != nil {
					t.Fatalf("replyFor() = %v, want no reply", resp)
				}

				return
			}

			if resp == nil || dst == nil || dst.String() != tt.wantDst {
				t.Fatalf("replyFor() dst = %v, want %s", dst, tt.wantDst)
			}
			if got := len(resp.Question) == 1; got != tt.wantID {
				t.Fatalf("question echoed = %v, want %v", got, tt.wantID)
			}
		})
	}
}
