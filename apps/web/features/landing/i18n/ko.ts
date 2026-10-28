import { githubUrl, discordUrl } from "../components/shared";
import { createEnDict } from "./en";
import type { LandingDict } from "./types";

export function createKoDict(
  allowSignup: boolean,
  docsHref: string,
): LandingDict {
  const base = createEnDict(allowSignup, docsHref);

  return {
    ...base,
    header: {
      cta: "시작하기",
      dashboard: "대시보드",
      changelog: "변경 로그",
      navigation: "주요 메뉴",
      openMenu: "메뉴 열기",
      closeMenu: "메뉴 닫기",
    },
    hero: {
      headlineLine1: "작업은 에이전트에게,",
      headlineLine2: "동료에게 맡기듯이.",
      subheading:
        "사람과 에이전트가 한 곳에서 협업합니다.",
      cta: "무료로 시작하기",
      downloadDesktop: "데스크톱 다운로드",
      worksWith: "20개 이상의 AI 코딩 도구 지원",
      imageAlt: "사람과 AI 에이전트가 함께 태스크를 관리하는 Marvis 보드 화면",
    },
    howItWorks: {
      headline: "한 시간이면, 첫 AI 직원을.",
      steps: [
        allowSignup
          ? { title: "가입하고 워크스페이스 만들기", description: "이메일 인증 후 바로 사용합니다." }
          : { title: "워크스페이스에 로그인", description: "이메일 인증으로 로그인합니다." },
        { title: "컴퓨터 연결", description: "marvis setup을 실행합니다." },
        { title: "에이전트 만들기", description: "이름, 지침, 스킬을 설정합니다." },
        { title: "작업 할당", description: "동료에게 맡기듯 할당하고 진행을 지켜봅니다." },
      ],
      cta: "시작하기",
      ctaGithub: "GitHub에서 보기",
      ctaDocs: "문서 읽기",
    },
    footer: {
      tagline:
        "사람과 AI 에이전트가 함께 일하는 팀을 위한 프로젝트 관리 도구. 소스 코드가 공개되어 있으며, 원하는 곳에 직접 호스팅할 수 있습니다.",
      cta: "시작하기",
      groups: {
        product: {
          label: "제품",
          links: [
            { label: "작동 방식", href: "#how-it-works" },
            { label: "변경 로그", href: "/changelog" },
            { label: "다운로드", href: "/download" },
          ],
        },
        resources: {
          label: "리소스",
          links: [
            { label: "문서", href: docsHref },
            { label: "API", href: githubUrl },
            { label: "X (Twitter)", href: "https://x.com/MarvisAI" },
            { label: "Discord", href: discordUrl },
          ],
        },
        company: {
          label: "회사",
          links: [
            { label: "라이선스", href: "/licensing" },
            { label: "영업팀 문의", href: "/contact-sales" },
            { label: "GitHub", href: githubUrl },
          ],
        },
      },
      copyright: "© {year} Marvis. All rights reserved.",
    },
    changelog: {
      title: "변경 로그",
      subtitle: "Marvis의 새로운 업데이트와 개선 사항입니다.",
      toc: "모든 릴리스",
      categories: {
        features: "새 기능",
        improvements: "개선 사항",
        fixes: "버그 수정",
      },
      entries: [
        {
          version: "0.0.1",
          date: "2026-10-28",
          title: "Marvis 첫 번째 릴리스",
          changes: [
            "사람과 에이전트가 한 곳에서 협업합니다. 동료에게 맡기듯 에이전트에게 작업을 할당하세요.",
          ],
        },
      ],
    },
    licensing: {
      title: "라이선스",
      intro: [
        "Marvis는 [Marvis License](https://github.com/yunboom/marvis/blob/main/LICENSE)로 배포됩니다. Apache License 2.0에 몇 가지 추가 조건을 더한 라이선스입니다. 소스 코드는 공개되어 있으며, 조직 내부에서 Marvis를 사용하는 것은 무료입니다. 팀 전체를 위해 셀프 호스팅하는 경우도 마찬가지입니다.",
        "가장 중요한 추가 조건은 호스팅 방식의 이용에 관한 것입니다. 조직 외부 사람들에게 Marvis를 제공하려면 상용 라이선스가 필요합니다. 이 페이지에서는 자주 받는 질문을 바탕으로 그 기준을 설명합니다. 이해를 돕기 위한 안내일 뿐 법률 자문이 아니며, LICENSE 원문과 다른 부분이 있다면 LICENSE가 우선합니다.",
      ],
      rule: {
        title: "판단 기준",
        text: "조직 외부의 누군가가 이 인스턴스를 움직이고 있나요? 즉 태스크를 만들거나, 에이전트와 대화하거나, 작업을 실행시키고 있나요? 그렇다면 웹, Slack, API 등 어떤 경로를 통하든 호스팅 서비스에 해당합니다. 여러분의 팀이 Marvis로 만든 결과물만 받아 본다면 내부 사용입니다.",
      },
      scenarios: {
        title: "자주 묻는 사례",
        scenarioColumn: "사례",
        licenseColumn: "상용 라이선스",
        required: "필요",
        notRequired: "불필요",
        items: [
          {
            scenario: "조직 내부에서 Marvis 사용",
            example: "셀프 호스팅, 워크스페이스 수와 관계없이.",
            required: false,
          },
          {
            scenario: "고객을 위해 Marvis를 구축하고, 고객이 직접 소유하며 내부에서 사용",
            example: "도입 지원, 교육, 컨설팅, 커스터마이징 등.",
            required: false,
          },
          {
            scenario: "우리 팀이 Marvis로 고객 업무를 하고, 고객은 결과물만 받음",
            example: "예: Marvis로 콘텐츠 제작을 관리하고 완성본을 납품하는 에이전시.",
            required: false,
          },
          {
            scenario: "에이전트가 고객의 Slack 채널로 리포트나 알림을 일방적으로 보내기만 함",
            example: "고객은 메시지를 읽기만 하고 인스턴스와 상호작용하지 않습니다.",
            required: false,
          },
          {
            scenario: "자체 인프라에서 고객을 위해 Marvis 인스턴스를 운영·관리",
            example: "매니지드 서비스. 요금 부과 여부와 관계없습니다.",
            required: true,
          },
          {
            scenario: "조직 외부 사람이 여러분의 인스턴스에 로그인",
            example: "고객, 파트너, 일반 사용자가 자신의 계정을 갖는 경우.",
            required: true,
          },
          {
            scenario: "조직 외부 사람이 다른 경로로 여러분의 인스턴스를 움직임",
            example: "Marvis를 백엔드로 쓰는 공개 웹사이트, Slack 연동, API 등. 무료로 제공하더라도 마찬가지입니다.",
            required: true,
          },
          {
            scenario: "판매하거나 배포하는 제품에 Marvis를 포함",
            example: "Marvis가 다른 상용 제품의 구성 요소로 제공되는 경우.",
            required: true,
          },
        ],
      },
      sections: [
        {
          heading: "기타 조건",
          bullets: [
            "브랜딩: 서면으로 브랜딩 면제를 받지 않았다면, Marvis 인터페이스에 표시되는 Marvis 로고, 제품명, 저작권 및 출처 표시를 제거하거나 변경하지 마세요.",
            "출처 표시: Marvis 인터페이스 없이 백엔드, 데몬, CLI를 기반으로 제품을 만든다면 저작권 및 NOTICE 정보를 유지하고, 사용자용 문서에 Marvis를 기반으로 만들었다는 사실을 [GitHub 저장소](https://github.com/yunboom/marvis) 링크와 함께 밝혀 주세요.",
            "포크: 포크의 소스 코드를 공개하는 것 자체는 호스팅 서비스가 아니므로 상용 라이선스가 필요하지 않습니다. 다만 그 포크로 호스팅 서비스를 운영하는 사람은 각자 상용 라이선스를 받아야 합니다.",
            "상용 라이선스와 브랜딩 면제는 별개의 허가입니다. 하나를 받았다고 다른 하나가 포함되지는 않습니다.",
          ],
        },
        {
          heading: "상용 라이선스 받기",
          paragraphs: [
            "[영업팀 문의](/contact-sales)로 사용 사례를 알려 주시면 영업일 기준 3일 이내에 답변드립니다. 라이선스가 필요한지 잘 모르겠다면 [Discord](" + discordUrl + ")나 같은 양식으로 편하게 물어보세요.",
          ],
        },
      ],
    },
    download: {
      hero: {
        macArm64: {
          title: "macOS용 Marvis",
          sub: "Apple Silicon · 데몬 포함, 별도 설정 없음",
          primary: "다운로드(.dmg)",
          altZip: "또는 .zip 다운로드",
        },
        macIntel: {
          title: "macOS용 Marvis",
          sub: "Intel · 데몬 포함, 별도 설정 없음",
          primary: "다운로드(.dmg)",
          altZip: "또는 .zip 다운로드",
        },
        winX64: {
          title: "Windows용 Marvis",
          sub: "데몬 포함, 별도 설정 없음",
          primary: "다운로드(.exe)",
        },
        winArm64: {
          title: "Windows용 Marvis",
          sub: "ARM · 데몬 포함, 별도 설정 없음",
          primary: "다운로드(.exe)",
        },
        linux: {
          title: "Linux용 Marvis",
          sub: "데몬 포함, 별도 설정 없음",
          primary: "AppImage 다운로드",
          altFormats: "또는 .deb / .rpm",
        },
        unknown: {
          title: "플랫폼 선택",
          sub: "모든 설치 파일은 아래에 정리되어 있습니다.",
        },
        safariMacHint: "Intel Mac을 사용 중인가요? 아래에서 Intel 버전을 선택하세요.",
        archFallbackHint: "아키텍처가 맞지 않나요? 아래에서 모든 형식을 확인하세요.",
      },
      macHint: {
        trigger: "처음 실행 안내",
        title: "Mac에서 처음 열 때",
        sub: "앱이 Apple 서명을 받지 않아 첫 실행이 차단됩니다. 한 번만 처리하면 됩니다.",
        stepInstall: ".dmg를 열고 Marvis를 '응용 프로그램'으로 드래그합니다.",
        stepCommand: "'손상됨' 또는 '개발자를 확인할 수 없음'이 표시되면 터미널에서 실행합니다:",
        stepReopen: "Marvis를 다시 엽니다.",
        altSettings: "터미널 없이: '시스템 설정 › 개인정보 보호 및 보안' 하단에서 '그래도 열기'를 클릭합니다.",
        noAutoUpdate: "자동 업데이트는 아직 지원하지 않습니다. 새 버전은 다운로드 페이지에서 받으세요.",
        copyLabel: "복사",
        copiedLabel: "복사됨",
        close: "닫기",
        confirm: "확인",
      },
      allPlatforms: {
        title: "모든 플랫폼",
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
        unavailable: "사용할 수 없음",
      },
      cli: {
        title: "CLI가 더 편하신가요?",
        sub: "서버, 원격 개발 환경, headless 환경에 적합합니다. 데스크톱과 동일한 데몬을 터미널에서 바로 설치할 수 있습니다.",
        installLabel: "설치",
        platformGroup: "플랫폼 선택",
        platformMacosLinux: "macOS / Linux",
        platformWindows: "Windows",
        startLabel: "데몬 시작",
        sshNote: "이미 서버에 접속해 있나요? 같은 명령을 SSH에서도 그대로 사용할 수 있습니다.",
        copyLabel: "복사",
        copiedLabel: "복사했습니다",
      },
      footer: {
        releaseNotes: "{version}의 새로운 내용",
        allReleases: "모든 릴리스 보기",
        currentVersion: "현재 버전: {version}",
        versionUnavailable: "버전을 확인할 수 없습니다. GitHub를 확인하세요.",
      },
    },
    contactSales: {
      pageTitle: "영업팀 문의",
      pageDescription:
        "회사에 사람과 에이전트가 함께 일하는 워크플로를 도입하는 방법을 Marvis 팀과 함께 이야기해 보세요.",
      eyebrow: "영업팀 문의",
      title: "어떤 도움이 필요하신지 알려 주세요",
      fields: {
        firstName: "이름",
        lastName: "성",
        businessEmail: "비즈니스 이메일",
        businessEmailHint:
          "회사 이메일을 사용하세요. Gmail, Outlook 등 개인 이메일은 사용할 수 없습니다.",
        companyName: "회사명",
        companySize: "회사 규모",
        countryRegion: "국가 / 지역",
        useCase: "Marvis를 어떻게 사용하거나 어디에 활용하실 계획인가요?",
        goals: "목표 또는 현재 겪고 있는 과제",
        selectPlaceholder: "선택하세요",
        submit: "제출",
        submitting: "제출 중...",
      },
      companySizes: [
        { value: "1-10", label: "직원 1-10명" },
        { value: "11-50", label: "직원 11-50명" },
        { value: "51-200", label: "직원 51-200명" },
        { value: "201-500", label: "직원 201-500명" },
        { value: "501-1000", label: "직원 501-1,000명" },
        { value: "1000+", label: "직원 1,000명 이상" },
      ],
      useCases: [
        { value: "evaluate", label: "팀 도입을 검토 중" },
        { value: "adopt_team", label: "팀 또는 회사에 Marvis 도입" },
        { value: "self_host", label: "자체 인프라에 셀프 호스팅" },
        { value: "integrate", label: "기존 도구와 Marvis 연동" },
        { value: "partner", label: "파트너십 또는 리셀러 문의" },
        { value: "other", label: "기타" },
      ],
      countries: [
        "미국",
        "캐나다",
        "영국",
        "독일",
        "프랑스",
        "네덜란드",
        "스웨덴",
        "스위스",
        "스페인",
        "이탈리아",
        "아일랜드",
        "노르웨이",
        "덴마크",
        "핀란드",
        "벨기에",
        "포르투갈",
        "호주",
        "뉴질랜드",
        "일본",
        "대한민국",
        "싱가포르",
        "홍콩 특별행정구",
        "대만",
        "중국 본토",
        "인도",
        "인도네시아",
        "태국",
        "베트남",
        "필리핀",
        "말레이시아",
        "아랍에미리트",
        "사우디아라비아",
        "이스라엘",
        "튀르키예",
        "남아프리카공화국",
        "브라질",
        "멕시코",
        "아르헨티나",
        "칠레",
        "기타",
      ],
      consent: {
        intro:
          "Marvis는 여러분의 개인정보를 소중히 다룹니다. 제공해 주신 개인정보는 계정 관리와 요청하신 제품·서비스 제공에만 사용합니다. 가끔씩 제품 업데이트, 활용 팁, 도움이 될 만한 인사이트도 함께 전해 드리고 싶습니다. 소식을 받고 싶으시다면 아래에서 선택해 주세요.",
        outreach:
          "서비스 업데이트, 지원 문의, 비즈니스 관련 후속 연락 등 Marvis로부터 개별 연락을 받겠습니다.",
        updates:
          "Marvis의 제품 업데이트, 인사이트, 이벤트 초대 소식을 받겠습니다.",
        unsubscribe:
          "언제든 수신을 거부할 수 있습니다. 개인정보와 데이터 권리를 어떻게 다루는지는 다음 문서에서 자세히 확인하실 수 있습니다:",
        submitConsent:
          "\"제출\"을 클릭하시면 요청하신 콘텐츠를 보내 드리기 위해 Marvis가 정보를 저장하고 처리하는 것에 동의하게 됩니다.",
        privacyLinkLabel: "개인정보 처리방침.",
        privacyLinkHref: "/privacy",
      },
      success: {
        title: "감사합니다. 요청을 잘 받았습니다.",
        message:
          "Marvis 팀원이 영업일 기준 3일 이내에 답변드릴 예정입니다. 그동안 문서를 둘러보시거나 GitHub에서 스타를 눌러 주세요.",
        cta: "홈으로 돌아가기",
      },
      errors: {
        generic: "문제가 발생했습니다. 잠시 후 다시 시도해 주세요.",
        rateLimit:
          "최근 이 주소에서 여러 건의 문의가 접수되었습니다. 잠시 후 다시 시도해 주세요.",
        freeEmail:
          "비즈니스 이메일 주소를 사용해 주세요. 무료 이메일 서비스(gmail, outlook 등)는 사용하실 수 없습니다.",
        invalidEmail: "올바른 이메일 주소 형식이 아닌 것 같습니다.",
      },
    },
  };
}
