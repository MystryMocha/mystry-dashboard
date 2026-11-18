/*
 * 矮屏减少滚动：浏览器原型（配合 docs/plans/vertical-density-design.md）。
 *
 * 用法：登录面板后，在浏览器开发者工具的控制台里粘贴整段运行，然后：
 *   mystryDensity.on()       打开四条原型
 *   mystryDensity.on([1, 3]) 只打开其中几条
 *   mystryDensity.off()      全部还原（DOM 改动刷新页面后才完全消失）
 *
 * 只在当前页面临时注入样式和 DOM，不改源码、不发请求、不改设置。React 重新渲染后由
 * MutationObserver 重新套用。原型里的中文文案只用于看效果，正式实现要走 i18n 三语言。
 */
(() => {
  const STYLE_ID = 'mystry-density-prototype';
  const CSS = {
    // 1. 实例页头：侧栏常驻时隐藏返回链接，名称和状态行收紧；标签栏不吸顶。
    1: `
@media (min-width: 1025px) { .instance-header .back-link { display: none; } }
.instance-header { gap: 0; }
.instance-meta { margin-top: 4px; }`,
    // 2. 矮屏自动收紧：只在桌面宽度下按高度生效，大标题保持 30px。
    2: `
@media (max-height: 820px) and (min-width: 1025px) {
  :root { --toolbar-height: 56px; }
  .content-container { padding-top: calc(var(--toolbar-height) + 2px); }
  .page { gap: 18px; }
  .instance-page { gap: 14px; }
  .page-header { padding-top: 0; }
  .page-subtitle { margin-top: 4px; }
  .form-section { gap: 8px; }
}`,
    // 3. JVM 预览进折叠区由 DOM 处理；这里只让安装说明和按钮同一行。
    3: `
.java-install.proto-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.java-install.proto-row > p { flex: 1 1 360px; margin: 0; }`,
    // 4. 操作栏里的短同意项。
    4: `
.proto-eula { display: inline-flex; align-items: center; gap: 8px; font-size: var(--text-small); color: var(--label); white-space: nowrap; }
.proto-eula input { width: 16px; height: 16px; accent-color: var(--accent); }
@media (pointer: coarse) { .proto-eula { min-height: 44px; } }`,
  };

  let enabled = new Set();
  let observer = null;

  const sectionByTitle = (text) =>
    [...document.querySelectorAll('.form-section')].find((s) => s.querySelector('.form-section-title')?.textContent.includes(text));

  function applyDom() {
    // 1. 滚动后顶栏胶囊显示实例名，而不是「实例工作台」。
    if (enabled.has(1)) {
      const title = document.querySelector('.toolbar-title');
      const name = document.querySelector('.instance-name')?.textContent;
      if (title && name && title.textContent !== name) title.textContent = name;
    }

    // 3. 「最终参数」移进「高级 JVM 参数」折叠区；Java 说明去重，推荐版本写进字段标签。
    if (enabled.has(3)) {
      for (const editor of document.querySelectorAll('.jvm-settings')) {
        const preview = editor.querySelector(':scope > .jvm-args-preview');
        const advanced = editor.querySelector('details.jvm-advanced');
        if (preview && advanced) advanced.appendChild(preview);
      }
      const runtime = sectionByTitle('运行环境') ?? sectionByTitle('运行时');
      if (runtime) {
        const helps = [...runtime.querySelectorAll(':scope .card > p.field-help, :scope .card > div > p.field-help')];
        let recommended = null;
        for (const p of helps) {
          const m = p.textContent.match(/推荐使用 (Java \d+)/);
          if (m) { recommended = m[1]; p.style.display = 'none'; }
          if (p.textContent.startsWith('不选择时使用系统默认 Java')) p.style.display = 'none';
        }
        const label = runtime.querySelector('label');
        if (label && recommended && !label.dataset.proto) {
          label.dataset.proto = '1';
          label.append(`（推荐 ${recommended}）`);
        }
        runtime.querySelector('.java-install')?.classList.add('proto-row');
      }
    }

    // 4. EULA 同意项放进操作栏，第 4 节只留进度、错误和 Java 警告。
    if (enabled.has(4)) {
      const confirm = sectionByTitle('确认并部署');
      const bar = document.querySelector('.action-bar');
      if (confirm && bar) {
        const original = confirm.querySelector('label.checkbox-field');
        const originalInput = original?.querySelector('input[type=checkbox]');
        if (original) original.style.display = 'none';
        for (const p of confirm.querySelectorAll('p.field-help')) {
          if (p.textContent.includes('必须同意 EULA')) p.style.display = 'none';
        }
        if (originalInput && !bar.querySelector('.proto-eula')) {
          const proxy = document.createElement('label');
          proxy.className = 'proto-eula';
          proxy.innerHTML = '<input type="checkbox"> 同意 <a class="link" href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a>';
          const box = proxy.querySelector('input');
          box.checked = originalInput.checked;
          // 点代理勾选框时转点原勾选框，部署按钮的启用状态仍由页面自己的逻辑决定。
          box.addEventListener('change', () => { if (box.checked !== originalInput.checked) originalInput.click(); });
          bar.insertBefore(proxy, bar.querySelector('button'));
        }
        const status = bar.querySelector('.action-bar-status');
        if (status && originalInput) {
          if (!originalInput.checked && !status.dataset.proto) {
            status.dataset.proto = status.textContent;
            status.textContent = '勾选同意 Minecraft EULA 后才能部署';
          } else if (originalInput.checked && status.dataset.proto) {
            status.textContent = status.dataset.proto;
            delete status.dataset.proto;
          }
        }
        // 第 4 节没有可见内容时整节隐藏；先取消隐藏再量，进度或错误出现时才能重新显示。
        confirm.style.display = '';
        const visible = [...confirm.querySelectorAll('.card > *')].some((el) => el.offsetParent !== null);
        confirm.style.display = visible ? '' : 'none';
      }
    }
  }

  function on(items = [1, 2, 3, 4]) {
    enabled = new Set(items);
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [...enabled].map((i) => CSS[i]).join('\n');
    document.head.appendChild(style);
    observer?.disconnect();
    observer = new MutationObserver(() => {
      observer.disconnect();
      applyDom();
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    applyDom();
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return `已打开原型 ${[...enabled].join('、')}`;
  }

  function off() {
    observer?.disconnect();
    observer = null;
    enabled = new Set();
    document.getElementById(STYLE_ID)?.remove();
    return '样式已还原；移动过的元素刷新页面后复原';
  }

  window.mystryDensity = { on, off };
  return '原型已加载：mystryDensity.on() 打开，mystryDensity.off() 还原';
})();
