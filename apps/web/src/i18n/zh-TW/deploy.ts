import type en from '../en/deploy';

/** 一键部署页文案（繁體中文）。 */
export default {
  'deploy.page.subtitle': '從官方來源下載伺服器核心，自動完成安裝與啟動設定。',

  'deploy.core.title': '選擇伺服器核心',
  'deploy.core.paper.desc': '插件伺服器，新手推薦',
  'deploy.core.fabric.desc': '輕量的現代模組',
  'deploy.core.forge.desc': '經典的大型模組',
  'deploy.core.neoforge.desc': '新一代模組伺服器',
  'deploy.core.vanilla.desc': 'Mojang 原版',

  'deploy.basic.title': '基本資訊',
  'deploy.form.name.label': '實例名稱',
  'deploy.form.name.default': '我的伺服器',
  'deploy.form.optionalLabel': '{label}（選填）',
  'deploy.form.mcVersion.label': '遊戲版本',
  'deploy.form.mcVersion.placeholder.noCore': '請先選擇上方的核心',
  'deploy.form.mcVersion.placeholder.loading': '正在取得版本清單…',
  'deploy.form.mcVersion.placeholder.select': '請選擇遊戲版本',
  'deploy.form.mcVersion.empty': '目前沒有可用的版本',
  'deploy.form.paperBuild.label': 'Paper 建置版本（選填）',
  'deploy.form.paperBuild.placeholder': '自動使用最新建置（優先使用穩定版）',
  'deploy.form.paperBuild.empty': '目前沒有 Build',
  'deploy.form.loader.forge': 'Forge 版本',
  'deploy.form.loader.neoforge': 'NeoForge 版本',
  'deploy.form.loader.default': 'Loader 版本',
  'deploy.form.installer.label': '安裝程式版本（選填）',
  'deploy.form.latestStable': '自動使用最新穩定版',
  'deploy.form.versionEmpty': '目前沒有版本',
  'deploy.form.forgeHelp': 'Forge / NeoForge 需要先下載官方安裝程式並完成安裝，花費的時間會比其他核心長一些。',
  'deploy.form.metadataError': '無法取得版本資訊：{error}',

  'deploy.runtime.title': '執行環境',

  'deploy.confirm.title': '確認並部署',
  'deploy.confirm.eulaHelp': 'Minecraft 伺服器必須同意 EULA 才能執行，勾選後才能開始部署。',
  'deploy.confirm.javaRequired': '這個版本需要 Java {java}。在上面的「Java 執行環境」中安裝或選擇 Java {java} 後才能開始部署。',
  'deploy.progress.label': '部署進度',
  'deploy.progress.submitted': '已開始部署。你可以離開此頁，在右上角的「任務中心」查看進度。',
  'deploy.error.title': '部署失敗',
  'deploy.error.detailTitle': '部署錯誤詳細資訊',
  'deploy.error.jvmInvalid': '請先修正 JVM 參數錯誤',

  'deploy.action.noCore': '尚未選擇核心',
  'deploy.action.running': '部署任務執行中…',
  'deploy.action.start': '開始部署',

  'deploy.guide.ariaLabel': '新手指南',
  'deploy.guide.core.title': '要選哪個核心？',
  'deploy.guide.core.paper': '<strong>Paper</strong>：想安裝插件（領地、經濟等）就選它。',
  'deploy.guide.core.modded': '<strong>Fabric / NeoForge / Forge</strong>：想安裝模組時，依照模組頁面要求的載入器選擇。',
  'deploy.guide.core.vanilla': '<strong>Vanilla</strong>：純原版，不安裝插件和模組。',
  'deploy.guide.after.title': '部署完成後',
  'deploy.guide.after.start': '在實例頁點「啟動」，等主控台出現 <code>Done</code>。',
  'deploy.guide.after.local': '在同一台電腦的遊戲中新增伺服器位址 <code>127.0.0.1</code>。',
  'deploy.guide.after.friends': '想讓朋友加入，請開啟「多人連線」頁，那裡有要傳給朋友的位址。',
} satisfies Record<keyof typeof en, string>;
