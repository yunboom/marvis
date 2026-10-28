import { githubUrl, discordUrl } from "../components/shared";
import type { LandingDict } from "./types";

export function createZhDict(
  allowSignup: boolean,
  docsHref: string,
): LandingDict {
  return {
  header: {
    cta: "\u5f00\u59cb\u4f7f\u7528",
    dashboard: "\u8fdb\u5165\u5de5\u4f5c\u53f0",
    changelog: "\u66f4\u65b0\u65e5\u5fd7",
    navigation: "\u4e3b\u5bfc\u822a",
    openMenu: "\u6253\u5f00\u5bfc\u822a\u83dc\u5355",
    closeMenu: "\u5173\u95ed\u5bfc\u822a\u83dc\u5355",
  },

  hero: {
    headlineLine1: "把任务交给智能体，",
    headlineLine2: "像交给同事一样。",
    subheading:
      "人类和智能体，在一个工作台里协作。",
    cta: "免费开始",
    downloadDesktop: "下载桌面端",
    worksWith: "支持 20+ 种 AI 编程工具",
    imageAlt: "Marvis \u770b\u677f\u89c6\u56fe\u2014\u2014\u4eba\u7c7b\u548c 智能体 \u534f\u540c\u7ba1\u7406\u4efb\u52a1",
  },

  howItWorks: {
    headline: "一小时，招募第一个 AI 员工。",
    steps: [
      allowSignup
        ? { title: "注册，创建工作区", description: "邮箱验证后即可使用。" }
        : { title: "登录工作区", description: "邮箱验证后即可登录。" },
      { title: "连接你的电脑", description: "运行 marvis setup。" },
      { title: "创建智能体", description: "起名字，写指令，加技能。" },
      { title: "指派任务", description: "像指派同事一样，看它干活。" },
    ],
    cta: "开始使用",
    ctaGithub: "在 GitHub 上查看",
    ctaDocs: "阅读文档",
  },

  footer: {
    tagline:
      "\u4eba\u7c7b + 智能体 团队的项目管理。源码公开、可自托管、\u4e3a\u672a\u6765\u7684\u5de5\u4f5c\u65b9\u5f0f\u800c\u5efa\u3002",
    cta: "\u5f00\u59cb\u4f7f\u7528",
    groups: {
      product: {
        label: "\u4ea7\u54c1",
        links: [
          { label: "\u5982\u4f55\u5de5\u4f5c", href: "#how-it-works" },
          { label: "更新日志", href: "/changelog" },
          { label: "下载", href: "/download" },
        ],
      },
      resources: {
        label: "\u8d44\u6e90",
        links: [
          { label: "\u6587\u6863", href: docsHref },
          { label: "API", href: githubUrl },
          { label: "X (Twitter)", href: "https://x.com/MarvisAI" },
          { label: "Discord", href: discordUrl },
        ],
      },
      company: {
        label: "\u5173\u4e8e",
        links: [
          { label: "授权说明", href: "/licensing" },
          { label: "\u8054\u7cfb\u5546\u52a1", href: "/contact-sales" },
          { label: "GitHub", href: githubUrl },
        ],
      },
    },
    copyright: "\u00a9 {year} Marvis. \u4fdd\u7559\u6240\u6709\u6743\u5229\u3002",
  },

  licensing: {
    title: "授权说明",
    intro: [
      "Marvis 采用 [Marvis License](https://github.com/yunboom/marvis/blob/main/LICENSE) 发布：在 Apache License 2.0 的基础上附加了几项条件。源代码公开，在你自己的组织内部使用 Marvis 是免费的，包括为整个团队自托管。",
      "最主要的附加条件针对托管使用：把 Marvis 提供给组织外部的人使用，需要商业授权。这一页用大家最常问的问题，说明这条线划在哪里。这是一份通俗说明，不构成法律意见；如与 LICENSE 原文不一致，以 LICENSE 为准。",
    ],
    rule: {
      title: "一条判断标准",
      text: "看组织外部的人有没有在驱动这个实例——创建任务、和智能体对话、触发工作。只要有，不管通过什么界面（Web、Slack 还是 API），都算托管服务；如果他们只是收到你的团队用 Marvis 做出来的成果，就属于内部使用。",
    },
    scenarios: {
      title: "常见场景",
      scenarioColumn: "场景",
      licenseColumn: "商业授权",
      required: "需要",
      notRequired: "不需要",
      items: [
        {
          scenario: "你的组织内部使用 Marvis",
          example: "自托管，不限工作区数量。",
          required: false,
        },
        {
          scenario: "你帮客户部署 Marvis，由客户自己拥有、在其组织内部使用",
          example: "实施、培训、咨询或定制开发。",
          required: false,
        },
        {
          scenario: "你的团队用 Marvis 为客户干活，客户只收到交付物",
          example: "例如 agency 在 Marvis 里管理内容生产，向客户交付成品。",
          required: false,
        },
        {
          scenario: "智能体只向客户的 Slack 频道单向推送报告或通知",
          example: "客户只看消息，不与实例做任何交互。",
          required: false,
        },
        {
          scenario: "你在自己的基础设施上替客户运行和管理 Marvis 实例",
          example: "即代运维服务（managed service），无论是否收费。",
          required: true,
        },
        {
          scenario: "组织外部的人登录你的实例",
          example: "客户、合作伙伴或公众拥有自己的账号。",
          required: true,
        },
        {
          scenario: "组织外部的人通过其他入口驱动你的实例",
          example: "例如接入 Marvis 后端的公开网站、Slack 集成或 API，免费提供也一样。",
          required: true,
        },
        {
          scenario: "你把 Marvis 嵌入到你销售或分发的产品中",
          example: "Marvis 作为另一个商业产品的组件一起交付。",
          required: true,
        },
      ],
    },
    sections: [
      {
        heading: "其他条件",
        bullets: [
          "品牌：除非获得我们的书面品牌豁免，请保留 Marvis 界面中显示的 Marvis Logo、产品名称以及版权和署名信息。",
          "署名：如果你只基于 Marvis 的后端、守护进程或 CLI 构建产品、不使用 Marvis 界面，需要保留版权和 NOTICE 信息，并在面向用户的文档中注明产品基于 Marvis 构建，附上 [GitHub 仓库](https://github.com/yunboom/marvis)链接。",
          "Fork：公开发布 fork 的源代码不算托管服务，不需要商业授权。但任何用这个 fork 运营托管服务的人，都需要各自获得商业授权。",
          "商业授权和品牌豁免是两项独立的授权，获得其中一项不代表获得另一项。",
        ],
      },
      {
        heading: "获取商业授权",
        paragraphs: [
          "通过[联系商务](/contact-sales)告诉我们你的使用场景，我们会在三个工作日内回复。不确定自己的情况是否需要授权？可以在 [Discord](" + discordUrl + ") 上问我们，也可以通过同一个表单咨询。",
        ],
      },
    ],
  },

  changelog: {
    title: "\u66f4\u65b0\u65e5\u5fd7",
    subtitle: "Marvis \u7684\u6700\u65b0\u66f4\u65b0\u548c\u6539\u8fdb\u3002",
    toc: "\u5386\u53f2\u7248\u672c",
    categories: {
      features: "新功能",
      improvements: "改进",
      fixes: "问题修复",
    },
    entries: [
      {
        version: "0.0.1",
        date: "2026-10-28",
        title: "Marvis 首个版本",
        changes: [
          "人类和智能体在同一个工作台里协作，把任务指派给智能体，就像指派给同事。",
        ],
      },
    ],
  },
  download: {
    hero: {
      macArm64: {
        title: "Marvis for macOS",
        sub: "Apple Silicon · 内置守护进程，无需配置",
        primary: "下载 .dmg",
        altZip: "或下载 .zip",
      },
      macIntel: {
        title: "Marvis for macOS",
        sub: "Intel · 内置守护进程，无需配置",
        primary: "下载 .dmg",
        altZip: "或下载 .zip",
      },
      winX64: {
        title: "Marvis for Windows",
        sub: "内置守护进程，无需配置",
        primary: "下载 .exe",
      },
      winArm64: {
        title: "Marvis for Windows",
        sub: "ARM · 内置守护进程，无需配置",
        primary: "下载 .exe",
      },
      linux: {
        title: "Marvis for Linux",
        sub: "内置守护进程，无需配置",
        primary: "下载 AppImage",
        altFormats: "或 .deb / .rpm",
      },
      unknown: {
        title: "选择你的平台",
        sub: "下方是所有支持的安装包。",
      },
      safariMacHint: "Intel Mac？在下方选择 Intel 版本。",
      archFallbackHint: "架构不对？下方是所有可选格式。",
    },
    macHint: {
      trigger: "首次打开须知",
      title: "首次在 Mac 上打开",
      sub: "安装包未经 Apple 签名，第一次打开会被系统拦截，处理一次即可。",
      stepInstall: "打开 .dmg，把 Marvis 拖进「应用程序」。",
      stepCommand: "提示「已损坏」或「无法验证开发者」时，在终端运行：",
      stepReopen: "重新打开 Marvis。",
      altSettings: "不想用终端：在「系统设置 › 隐私与安全性」底部点「仍要打开」。",
      noAutoUpdate: "暂不支持自动更新，新版本请回到下载页下载。",
      copyLabel: "复制",
      copiedLabel: "已复制",
      close: "关闭",
      confirm: "知道了",
    },
    allPlatforms: {
      title: "所有平台",
      macArm64Label: "macOS · Apple Silicon",
      macX64Label: "macOS · Intel",
      winX64Label: "Windows · x64",
      winArm64Label: "Windows · ARM64",
      linuxX64Label: "Linux · x64",
      linuxArm64Label: "Linux · ARM64",
      formatDmg: ".dmg",
      formatZip: ".zip",
      formatExe: ".exe",
      formatAppImage: ".AppImage",
      formatDeb: ".deb",
      formatRpm: ".rpm",
      unavailable: "暂不可用",
    },
    cli: {
      title: "用命令行安装",
      sub: "适合服务器和没有图形界面的机器。",
      installLabel: "安装",
      platformGroup: "选择你的系统",
      platformMacosLinux: "macOS / Linux",
      platformWindows: "Windows",
      startLabel: "启动守护进程",
      sshNote: "在服务器上？通过 SSH 运行同样的命令。",
      copyLabel: "复制",
      copiedLabel: "已复制",
    },
    footer: {
      releaseNotes: "v{version} 更新内容",
      allReleases: "查看所有版本",
      currentVersion: "当前版本：{version}",
      versionUnavailable: "版本获取失败",
    },
  },
  contactSales: {
    pageTitle: "联系商务",
    pageDescription:
      "了解如何在你的团队中落地 Marvis 的人类 + 智能体协作工作流。",
    eyebrow: "联系商务",
    title: "先了解你的需求",
    fields: {
      firstName: "名",
      lastName: "姓",
      businessEmail: "企业邮箱",
      businessEmailHint:
        "请使用公司邮箱，不接受 Gmail、Outlook 等个人邮箱。",
      companyName: "公司名称",
      companySize: "公司规模",
      countryRegion: "国家 / 地区",
      useCase: "你打算如何使用 Marvis 或与我们合作？",
      goals: "你的目标或挑战",
      selectPlaceholder: "请选择",
      submit: "提交",
      submitting: "正在提交…",
    },
    companySizes: [
      { value: "1-10", label: "1 – 10 人" },
      { value: "11-50", label: "11 – 50 人" },
      { value: "51-200", label: "51 – 200 人" },
      { value: "201-500", label: "201 – 500 人" },
      { value: "501-1000", label: "501 – 1,000 人" },
      { value: "1000+", label: "1,000 人以上" },
    ],
    useCases: [
      { value: "evaluate", label: "正在为团队评估 Marvis" },
      { value: "adopt_team", label: "希望在团队 / 公司内推广使用" },
      { value: "self_host", label: "需要在自有基础设施上自托管" },
      { value: "integrate", label: "希望与现有工具集成" },
      { value: "partner", label: "合作 / 渠道合作咨询" },
      { value: "other", label: "其他" },
    ],
    countries: [
      "中国大陆",
      "中国香港",
      "中国澳门",
      "中国台湾",
      "新加坡",
      "马来西亚",
      "印度尼西亚",
      "泰国",
      "越南",
      "菲律宾",
      "日本",
      "韩国",
      "印度",
      "阿联酋",
      "沙特阿拉伯",
      "以色列",
      "土耳其",
      "美国",
      "加拿大",
      "英国",
      "德国",
      "法国",
      "荷兰",
      "瑞典",
      "瑞士",
      "西班牙",
      "意大利",
      "爱尔兰",
      "挪威",
      "丹麦",
      "芬兰",
      "比利时",
      "葡萄牙",
      "澳大利亚",
      "新西兰",
      "南非",
      "巴西",
      "墨西哥",
      "阿根廷",
      "智利",
      "其他",
    ],
    consent: {
      intro:
        "Marvis 尊重你的隐私。我们仅会将你的个人信息用于管理账户，以及提供你所请求的产品或服务。我们偶尔也希望与你分享产品更新、最佳实践或行业洞察，如果你愿意接收，请在下方勾选。",
      outreach:
        "我希望接收来自 Marvis 的一对一沟通，包括服务更新、支持咨询以及业务相关的跟进。",
      updates:
        "我希望接收 Marvis 的产品更新、洞察以及活动邀请。",
      unsubscribe:
        "你可以随时取消订阅我们的邮件。关于我们如何处理你的数据以及隐私权利，请参阅",
      submitConsent:
        "点击「提交」即表示你同意 Marvis 存储并处理你提交的信息，以便交付你请求的内容。",
      privacyLinkLabel: "隐私政策。",
      privacyLinkHref: "/privacy",
    },
    success: {
      title: "已收到，谢谢！",
      message:
        "Marvis 团队会在三个工作日内回复你。在此期间，欢迎查看我们的文档，或在 GitHub 上为我们点个 Star。",
      cta: "返回首页",
    },
    errors: {
      generic: "提交失败，请稍后再试。",
      rateLimit: "该邮箱近期已提交多次，请稍后再试。",
      freeEmail:
        "请使用企业邮箱——免费邮箱（gmail、outlook 等）暂不接受。",
      invalidEmail: "邮箱地址格式不正确。",
    },
  },
  };
}
