import type en from '../en/deploy';

/** 一键部署页文案（简体中文）。 */
export default {
  'deploy.page.subtitle': '从官方源下载服务端核心，自动完成安装与启动配置。',

  'deploy.core.title': '选择服务端核心',
  'deploy.core.paper.desc': '插件服，新手推荐',
  'deploy.core.fabric.desc': '轻量现代化模组',
  'deploy.core.forge.desc': '经典重型模组',
  'deploy.core.neoforge.desc': '新一代模组端',
  'deploy.core.vanilla.desc': 'Mojang 原版',

  'deploy.basic.title': '基本信息',
  'deploy.form.name.label': '实例名称',
  'deploy.form.name.default': '我的服务器',
  'deploy.form.optionalLabel': '{label}（可选）',
  'deploy.form.mcVersion.label': '游戏版本',
  'deploy.form.mcVersion.placeholder.noCore': '请先选择上方核心',
  'deploy.form.mcVersion.placeholder.loading': '正在获取版本列表…',
  'deploy.form.mcVersion.placeholder.select': '请选择游戏版本',
  'deploy.form.mcVersion.empty': '暂无可用版本',
  'deploy.form.paperBuild.label': 'Paper 构建版本（可选）',
  'deploy.form.paperBuild.placeholder': '自动使用最新构建（优先稳定版）',
  'deploy.form.paperBuild.empty': '暂无 Build',
  'deploy.form.loader.forge': 'Forge 版本',
  'deploy.form.loader.neoforge': 'NeoForge 版本',
  'deploy.form.loader.default': 'Loader 版本',
  'deploy.form.installer.label': 'Installer 版本（可选）',
  'deploy.form.latestStable': '自动使用最新稳定版',
  'deploy.form.versionEmpty': '暂无版本',
  'deploy.form.forgeHelp': 'Forge / NeoForge 需要先下载官方安装器并完成安装，耗时会比其他核心长一些。',
  'deploy.form.metadataError': '无法获取版本信息：{error}',

  'deploy.runtime.title': '运行环境',

  'deploy.confirm.title': '确认并部署',
  'deploy.confirm.eulaHelp': 'Minecraft 服务器必须同意 EULA 才能运行，勾选后才能开始部署。',
  'deploy.confirm.javaRequired': '这个版本需要 Java {java}。在上面的「Java 运行时」里安装或选择 Java {java} 后才能开始部署。',
  'deploy.progress.label': '部署进度',
  'deploy.progress.submitted': '部署任务已提交，可以离开此页，进度会在右上角「任务中心」持续更新。',
  'deploy.error.title': '部署失败',
  'deploy.error.detailTitle': '部署错误详情',
  'deploy.error.jvmInvalid': '请先修正 JVM 参数错误',

  'deploy.action.noCore': '尚未选择核心',
  'deploy.action.running': '部署任务运行中…',
  'deploy.action.start': '开始部署',

  'deploy.guide.ariaLabel': '新手指引',
  'deploy.guide.core.title': '选哪个核心？',
  'deploy.guide.core.paper': '<strong>Paper</strong>：想装插件（领地、经济等）选它，性能也更好。',
  'deploy.guide.core.modded': '<strong>Fabric / NeoForge / Forge</strong>：想装模组时，按模组页面要求的加载器选择。',
  'deploy.guide.core.vanilla': '<strong>Vanilla</strong>：纯原版，不装插件和模组。',
  'deploy.guide.after.title': '部署完成后',
  'deploy.guide.after.start': '在实例页点「启动」，等控制台出现 <code>Done</code>。',
  'deploy.guide.after.local': '同一台电脑的游戏里添加服务器地址 <code>127.0.0.1</code>。',
  'deploy.guide.after.friends': '想让朋友加入，打开「联机」页：它会给出要发给朋友的地址，朋友不在同一网络时也有别的办法。',
} satisfies Record<keyof typeof en, string>;
