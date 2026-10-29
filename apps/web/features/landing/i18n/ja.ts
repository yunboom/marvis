import { githubUrl, discordUrl } from "../components/shared";
import { createEnDict } from "./en";
import type { LandingDict } from "./types";

export function createJaDict(
  allowSignup: boolean,
  docsHref: string,
): LandingDict {
  const base = createEnDict(allowSignup, docsHref);

  return {
    ...base,
    header: {
      cta: "始める",
      dashboard: "ダッシュボード",
      changelog: "変更履歴",
      navigation: "メインナビゲーション",
      openMenu: "メニューを開く",
      closeMenu: "メニューを閉じる",
    },
    hero: {
      headlineLine1: "タスクをエージェントに、",
      headlineLine2: "同僚に頼むように。",
      subheading:
        "人とエージェントが、ひとつのワークスペースで協働。",
      downloadDesktop: "デスクトップ版をダウンロード",
      imageAlt: "人間と AI エージェントがタスクを管理する Marvis のボード画面",
    },
    howItWorks: {
      headline: "1 時間で、最初の AI 社員を。",
      steps: [
        allowSignup
          ? { title: "登録してワークスペースを作成", description: "メール認証ですぐに使えます。" }
          : { title: "ワークスペースにログイン", description: "メール認証でログインできます。" },
        { title: "PC を接続", description: "marvis setup を実行します。" },
        { title: "エージェントを作成", description: "名前、指示、スキルを設定します。" },
        { title: "タスクを割り当て", description: "同僚と同じように割り当てて、作業を見守ります。" },
      ],
      ctaGithub: "GitHub で見る",
      ctaDocs: "ドキュメントを読む",
    },
    footer: {
      tagline:
        "人間と AI エージェントが協働するチームのためのプロジェクト管理ツール。ソースコード公開で、セルフホスト可能。これからの働き方のために作られています。",
      cta: "始める",
      groups: {
        product: {
          label: "プロダクト",
          links: [
            { label: "仕組み", href: "#how-it-works" },
            { label: "変更履歴", href: "/changelog" },
            { label: "ダウンロード", href: "/download" },
          ],
        },
        resources: {
          label: "リソース",
          links: [
            { label: "ドキュメント", href: docsHref },
            { label: "API", href: githubUrl },
            { label: "X (Twitter)", href: "https://x.com/MarvisAI" },
            { label: "Discord", href: discordUrl },
          ],
        },
        company: {
          label: "会社",
          links: [
            { label: "ライセンス", href: "/licensing" },
            { label: "営業に相談", href: "/contact-sales" },
            { label: "GitHub", href: githubUrl },
          ],
        },
      },
      copyright: "© {year} Marvis. All rights reserved.",
    },
    changelog: {
      title: "変更履歴",
      subtitle: "Marvis の新しいアップデートと改善点をお届けします。",
      toc: "すべてのリリース",
      categories: {
        features: "新機能",
        improvements: "改善",
        fixes: "バグ修正",
      },
      entries: [
        {
          version: "0.0.2",
          date: "2026-10-29",
          title: "改善とバグ修正",
          changes: [
            "CLI はデフォルトで Marvis に接続します。marvis setup でサーバーアドレスを入力する必要はなくなりました。",
            "デスクトップ版の更新通知で「更新履歴を見る」が開けない問題を修正しました。",
          ],
        },
        {
          version: "0.0.1",
          date: "2026-10-28",
          title: "Marvis 最初のリリース",
          changes: [
            "人とエージェントがひとつのワークスペースで協働します。同僚に頼むように、タスクをエージェントに割り当てられます。",
          ],
        },
      ],
    },
    licensing: {
      title: "ライセンス",
      intro: [
        "Marvis は [Marvis License](https://github.com/yunboom/marvis/blob/main/LICENSE) のもとで公開されています。Apache License 2.0 に、いくつかの追加条件を加えたライセンスです。ソースコードは公開されており、自社の組織内で Marvis を使うのは無料です。チーム全体のためにセルフホストする場合も同様です。",
        "主な追加条件は、ホスティングでの利用に関するものです。組織外の人に Marvis を提供するには、商用ライセンスが必要です。このページでは、よくいただく質問をもとに、その線引きを説明します。これはわかりやすさを優先した案内であり、法的助言ではありません。LICENSE 本文と内容が異なる場合は、LICENSE が優先されます。",
      ],
      rule: {
        title: "判断の目安",
        text: "組織外の誰かが、このインスタンスを動かしているかどうか。つまり、タスクを作成したり、エージェントと対話したり、作業をトリガーしたりしているかどうかです。そうであれば、Web、Slack、API のどの経路でも、ホスティングサービスにあたります。あなたのチームが Marvis でつくった成果物を受け取るだけなら、社内利用です。",
      },
      scenarios: {
        title: "よくあるケース",
        scenarioColumn: "ケース",
        licenseColumn: "商用ライセンス",
        required: "必要",
        notRequired: "不要",
        items: [
          {
            scenario: "自社の組織内で Marvis を使う",
            example: "セルフホストで、ワークスペースの数は問いません。",
            required: false,
          },
          {
            scenario: "クライアントのために Marvis を導入し、クライアント自身が所有して社内で使う",
            example: "導入支援、トレーニング、コンサルティング、カスタマイズなど。",
            required: false,
          },
          {
            scenario: "自社チームが Marvis を使ってクライアントの仕事をし、クライアントは成果物だけを受け取る",
            example: "たとえば、Marvis でコンテンツ制作を管理し、完成品を納品するエージェンシー。",
            required: false,
          },
          {
            scenario: "エージェントがクライアントの Slack チャンネルにレポートや通知を一方向に送るだけ",
            example: "クライアントは内容を読むだけで、インスタンスとはやり取りしません。",
            required: false,
          },
          {
            scenario: "自社のインフラ上で、クライアントのために Marvis インスタンスを運用・管理する",
            example: "マネージドサービス。料金を取るかどうかは関係ありません。",
            required: true,
          },
          {
            scenario: "組織外の人があなたのインスタンスにログインする",
            example: "クライアント、パートナー、一般ユーザーが自分のアカウントを持つ場合。",
            required: true,
          },
          {
            scenario: "組織外の人が別の入口からあなたのインスタンスを動かす",
            example: "Marvis をバックエンドにした公開サイト、Slack 連携、API など。無料で提供する場合も同様です。",
            required: true,
          },
          {
            scenario: "販売・配布する製品に Marvis を組み込む",
            example: "Marvis が別の商用製品のコンポーネントとして提供される場合。",
            required: true,
          },
        ],
      },
      sections: [
        {
          heading: "そのほかの条件",
          bullets: [
            "ブランド: 書面によるブランド表示の免除を受けていない限り、Marvis のインターフェースに表示される Marvis のロゴ、製品名、著作権・帰属表示を削除・変更しないでください。",
            "帰属表示: Marvis のインターフェースを使わずに、バックエンド、デーモン、CLI の上に製品を構築する場合は、著作権表示と NOTICE の内容を残し、ユーザー向けドキュメントに Marvis をベースにしていることを [GitHub リポジトリ](https://github.com/yunboom/marvis)へのリンクとともに明記してください。",
            "フォーク: フォークのソースコードを公開すること自体はホスティングサービスではなく、商用ライセンスは不要です。ただし、そのフォークでホスティングサービスを運営する人は、それぞれ商用ライセンスが必要です。",
            "商用ライセンスとブランド表示の免除は別々の許諾です。一方を得ても、もう一方は含まれません。",
          ],
        },
        {
          heading: "商用ライセンスの取得",
          paragraphs: [
            "[営業に相談](/contact-sales)からユースケースをお知らせください。3営業日以内にご連絡します。ライセンスが必要かどうかわからない場合は、[Discord](" + discordUrl + ") または同じフォームからお気軽にお尋ねください。",
          ],
        },
      ],
    },
    download: {
      hero: {
        macArm64: {
          title: "macOS 版 Marvis",
          sub: "Apple Silicon · デーモン同梱、設定不要",
          primary: "ダウンロード(.dmg)",
          altZip: "または .zip をダウンロード",
        },
        macIntel: {
          title: "macOS 版 Marvis",
          sub: "Intel · デーモン同梱、設定不要",
          primary: "ダウンロード(.dmg)",
          altZip: "または .zip をダウンロード",
        },
        winX64: {
          title: "Windows 版 Marvis",
          sub: "デーモン同梱、設定不要",
          primary: "ダウンロード(.exe)",
        },
        winArm64: {
          title: "Windows 版 Marvis",
          sub: "ARM · デーモン同梱、設定不要",
          primary: "ダウンロード(.exe)",
        },
        linux: {
          title: "Linux 版 Marvis",
          sub: "デーモン同梱、設定不要",
          primary: "AppImage をダウンロード",
          altFormats: "または .deb / .rpm",
        },
        unknown: {
          title: "プラットフォームを選択",
          sub: "すべてのインストーラーは下にまとまっています。",
        },
        safariMacHint: "Intel Mac をお使いですか? 下の Intel 版を選択してください。",
        archFallbackHint: "アーキテクチャが合いませんか? 下ですべての形式を確認してください。",
      },
      releases: {
        back: "ダウンロード",
        title: "すべてのリリース",
        sub: "バージョンを開いて、プラットフォームを選びます。",
        latest: "最新",
        notesLink: "リリースノート",
        expand: "インストーラーを表示",
        collapse: "インストーラーを隠す",
        empty: "リリース一覧を取得できません",
      },
      releaseDetail: {
        back: "すべてのリリース",
        notesTitle: "リリースノート",
        notesFallback: "機能変更のないメンテナンスリリースです。",
        viewChangelog: "変更履歴を見る",
        downloadsTitle: "ダウンロード",
        cliHintPrefix: "CLI とデーモンのインストール方法は",
        cliHintLink: "ダウンロードページ",
      },
      macHint: {
        trigger: "初回起動の注意",
        title: "Mac で初めて開くとき",
        sub: "アプリは Apple の署名がないため、初回起動時にブロックされます。対応は一度だけです。",
        stepInstall: ".dmg を開き、Marvis を「アプリケーション」にドラッグします。",
        stepCommand: "「壊れている」「開発元を検証できません」と表示されたら、ターミナルで実行します：",
        stepReopen: "Marvis をもう一度開きます。",
        altSettings: "ターミナルを使わない場合：「システム設定 › プライバシーとセキュリティ」の下部で「このまま開く」をクリックします。",
        noAutoUpdate: "自動アップデートには未対応です。新しいバージョンはダウンロードページから入手してください。",
        copyLabel: "コピー",
        copiedLabel: "コピーしました",
        close: "閉じる",
        confirm: "了解",
      },
      allPlatforms: {
        title: "すべてのプラットフォーム",
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
        unavailable: "利用できません",
      },
      cli: {
        title: "CLI のほうが便利ですか?",
        sub: "サーバー、リモート開発環境、ヘッドレス環境に最適です。デスクトップと同じデーモンを、ターミナルからインストールできます。",
        installLabel: "インストール",
        platformGroup: "プラットフォームを選択",
        platformMacosLinux: "macOS / Linux",
        platformWindows: "Windows",
        startLabel: "デーモンを起動",
        sshNote: "すでにサーバーに接続中ですか? 同じコマンドが SSH 上でもそのまま使えます。",
        copyLabel: "コピー",
        copiedLabel: "コピーしました",
      },
      footer: {
        releaseNotes: "{version} の新着情報",
        allReleases: "すべてのリリースを見る",
        currentVersion: "現在のバージョン: {version}",
        versionUnavailable: "バージョンを取得できません",
      },
    },
    contactSales: {
      pageTitle: "営業に相談",
      pageDescription:
        "人間と AI エージェントが協働するワークフローを社内に導入する方法について、Marvis チームにご相談ください。",
      eyebrow: "営業に相談",
      title: "まずは、ご要望をお聞かせください",
      fields: {
        firstName: "名",
        lastName: "姓",
        businessEmail: "ビジネスメール",
        businessEmailHint:
          "会社のメールアドレスを使用してください。Gmail、Outlook などの個人用メールは受け付けていません。",
        companyName: "会社名",
        companySize: "会社規模",
        countryRegion: "国 / 地域",
        useCase: "Marvis をどのように利用、または活用するご予定ですか?",
        goals: "目標または現在抱えている課題",
        selectPlaceholder: "選択してください",
        submit: "送信",
        submitting: "送信中...",
      },
      companySizes: [
        { value: "1-10", label: "従業員 1〜10名" },
        { value: "11-50", label: "従業員 11〜50名" },
        { value: "51-200", label: "従業員 51〜200名" },
        { value: "201-500", label: "従業員 201〜500名" },
        { value: "501-1000", label: "従業員 501〜1,000名" },
        { value: "1000+", label: "従業員 1,000名以上" },
      ],
      useCases: [
        { value: "evaluate", label: "チームでの導入を検討中" },
        { value: "adopt_team", label: "チームまたは会社に Marvis を導入" },
        { value: "self_host", label: "自社インフラにセルフホスト" },
        { value: "integrate", label: "既存ツールと Marvis を連携" },
        { value: "partner", label: "パートナーシップまたはリセラーのお問い合わせ" },
        { value: "other", label: "その他" },
      ],
      countries: [
        "アメリカ合衆国",
        "カナダ",
        "イギリス",
        "ドイツ",
        "フランス",
        "オランダ",
        "スウェーデン",
        "スイス",
        "スペイン",
        "イタリア",
        "アイルランド",
        "ノルウェー",
        "デンマーク",
        "フィンランド",
        "ベルギー",
        "ポルトガル",
        "オーストラリア",
        "ニュージーランド",
        "日本",
        "韓国",
        "シンガポール",
        "香港特別行政区",
        "台湾",
        "中国本土",
        "インド",
        "インドネシア",
        "タイ",
        "ベトナム",
        "フィリピン",
        "マレーシア",
        "アラブ首長国連邦",
        "サウジアラビア",
        "イスラエル",
        "トルコ",
        "南アフリカ",
        "ブラジル",
        "メキシコ",
        "アルゼンチン",
        "チリ",
        "その他",
      ],
      consent: {
        intro:
          "Marvis はあなたのプライバシーを尊重します。お預かりした個人情報は、アカウントの管理と、ご依頼いただいた製品・サービスの提供のためにのみ使用します。ときどき、製品アップデートやベストプラクティス、ご参考になりそうなインサイトもお届けできればと思います。ご希望の場合は、下でお知らせください。",
        outreach:
          "サービスのアップデート、サポートへのお問い合わせ、ビジネス関連のフォローアップなど、Marvis からの個別のご連絡を受け取ります。",
        updates:
          "Marvis からの製品アップデート、インサイト、イベントへのご招待を受け取ります。",
        unsubscribe:
          "配信はいつでも停止できます。データの取り扱いとプライバシーの権利について詳しくは、こちらをご確認ください:",
        submitConsent:
          "「送信」をクリックすると、ご依頼いただいたコンテンツをお届けするために、Marvis が情報を保存・処理することに同意したことになります。",
        privacyLinkLabel: "プライバシーポリシー。",
        privacyLinkHref: "/privacy",
      },
      success: {
        title: "ありがとうございます。確かに受け取りました。",
        message:
          "Marvis チームのメンバーが、3営業日以内にご返信いたします。それまでの間、ドキュメントを覗いてみたり、GitHub でスターを付けたりしてお待ちください。",
        cta: "ホームに戻る",
      },
      errors: {
        generic: "問題が発生しました。少し時間をおいて、もう一度お試しください。",
        rateLimit:
          "最近このアドレスから、いくつかのお問い合わせを受け取っています。しばらくしてから、もう一度お試しください。",
        freeEmail:
          "ビジネスメールアドレスをご利用ください。無料のメールサービス(gmail、outlook など)はご利用いただけません。",
        invalidEmail: "有効なメールアドレスではないようです。",
      },
    },
  };
}
