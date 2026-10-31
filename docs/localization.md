# Localization

Writing rules for every language of the web UI, how to add a language, and right-to-left layout. Visual rules are in the [Design System](design-system.md).

## Status

| Locale | Language | State |
|---|---|---|
| `en` | English | Shipped; default and fallback locale |
| `zh-CN` | 简体中文 | Shipped |
| `zh-TW` | 繁體中文 (Taiwan usage) | Shipped; not yet reviewed by a native speaker |
| `fr`, `ru`, `es` | Français, Русский, Español | Planned; draft glossary below |
| `ar` | العربية (right-to-left) | Planned; needs the right-to-left work below first |

Together these are the six official UN languages. The implementation lives in [`apps/web/src/i18n/`](../apps/web/src/i18n/): `LOCALES` and the browser-language detection in `locale.ts`, one table per UI area in `en/<area>.ts`, and the same keys in every other locale. Messages produced by the server (errors, task progress, console errors) are translated too, see [Server messages](#server-messages) ().

**The glossary is code.** Status words, common actions and navigation names are defined once in [`i18n/en/common.ts`](../apps/web/src/i18n/en/common.ts) and its `zh-CN` / `zh-TW` counterparts. Use those strings; do not paraphrase them per screen, and do not copy them into this page.

## Rules for every locale

- Every user-visible string lives in a locale table keyed by meaning (`instance.status.running`), never inline in a component. Missing keys fall back to `en`.
- `<html lang>` follows the active locale so the browser picks the right glyphs from the font stack; Arabic also needs `dir="rtl"`.
- Layouts must survive the longest locale: English is often twice as wide as Chinese, and French, Russian and Spanish run another 20–35% longer. Buttons, chips, pills and labels in scrolling rows use `white-space: nowrap` and `flex-shrink: 0`; titles wrap, they never truncate a verb.
- Never concatenate sentence fragments; use `{name}` parameters. Never pick a plural by hand; use `tp()` (`Intl.PluralRules`).
- Format numbers, dates and sizes with `useI18n().fmt` and keep a space between number and unit. Do not construct `Intl.*` objects in components: `fmt` (and `numberFormat()` / `dateTimeFormat()` in `i18n/index.ts`) reuse cached instances per locale and options, and `fmt` keeps the same reference until the locale changes, so it is safe to pass to memoized rows. Digits stay Western (0–9) in every locale, Arabic included, so ports, versions and log lines read the same everywhere.
- Technical names (`Paper`, `JVM`, `server.properties`, Minecraft commands) are never translated.

## Server messages

The server never writes user-facing text in Chinese or any other locale. It returns a stable key with parameters, plus the rendered English text for scripts and older clients:

- English templates live in [`packages/shared/src/messages/<area>.ts`](../packages/shared/src/messages/), keyed `server.<area>.<meaning>`. Translations live in `apps/web/src/i18n/zh-CN/server/<area>.ts` and `zh-TW/server/<area>.ts`; type checking requires the same keys as the shared templates.
- Server code throws `PanelError(key, params)`, replies with `panelErrorBody(key, params)` or `sendRouteError`, and reports task progress as `report(progress, { key, params })`. A parameter can itself be a message, so a reason is translated inside its sentence.
- The web app shows them with `errorMessage(error)` or `useI18n().tm(message, fallbackText)`; without a key (raw Node.js, Java or network text, or tasks stored before this change) it shows the text as is.
- Startup logs written to the terminal stay out of scope.

## Per-language rules

### English (`en`)

- Title Case for page titles, section titles, buttons, menu items and tabs; sentence case for subtitles, descriptions, help, callouts and dialog bodies.
- Address the user as "you". Short, plain sentences ending with a period; straight quotation marks.

### 简体中文 (`zh-CN`)

- 称呼用「你」，语气平实，不用感叹号和 emoji。
- 按钮写动作，两到四个字；危险确认写清后果。
- 引号用「」；数字与单位之间留空格；副标题一句话，以句号结尾。

### 繁體中文 (`zh-TW`)

- 以台灣慣用詞為準，不要直接把簡體轉成繁體：伺服器、檔案、資料夾、連線、載入、設定、主控台、指令、當機。
- 稱呼用「你」，語氣平實，不用驚嘆號和 emoji；標點使用全形，引號用「」。
- `:root:lang(zh-TW)` 在 `styles.css` 中把繁體字型排在簡體字型之前；新增字型堆疊時保持這個順序。

### Français (`fr`)

- Vouvoyez l'utilisateur (« vous »). Phrases courtes et neutres, sans point d'exclamation ni emoji.
- Majuscule uniquement au premier mot, partout : titres, boutons, onglets (« Déploiement rapide »).
- Guillemets « » avec espaces insécables ; espace insécable avant `:` `;` `?` `!`.
- Les états s'accordent avec « instance » (féminin) : Arrêtée, Plantée.

### Русский (`ru`)

- Обращение на «вы» со строчной буквы. Коротко и нейтрально, без восклицательных знаков и эмодзи.
- Заглавная буква только в начале строки — в заголовках, кнопках и вкладках тоже.
- Кавычки «ёлочки»; буква «ё» пишется везде, где она есть.
- Кнопки — инфинитив глагола («Запустить»). Статусы согласуются с «экземпляр» (мужской род).

### Español (`es`)

- Trata al usuario de «tú». Frases cortas y neutras, sin exclamaciones ni emoji.
- Mayúscula solo en la primera palabra, también en títulos, botones y pestañas («Despliegue rápido»).
- Comillas « ». Los estados concuerdan con «instancia» (femenino): Detenida, Bloqueada.
- Español neutro, sin regionalismos (archivo, no fichero; equipo, no ordenador ni computadora).

### العربية (`ar`)

- خاطب المستخدم بصيغة الأمر المفرد المحايدة قدر الإمكان، بجمل قصيرة وواضحة، دون علامات تعجب أو رموز تعبيرية.
- استخدم الفاصلة «،» وعلامة الاستفهام «؟» وعلامات التنصيص « ».
- تبقى الأرقام غربية (0–9)، وتبقى أسماء الملفات والأوامر والمسارات بالحروف اللاتينية.

## Adding a locale

1. Add the code to `LOCALES`, its native name to `LOCALE_NATIVE_NAMES` and its browser match to `detectLocale()` in `locale.ts`, and keep the inline detection script in `apps/web/index.html` identical.
2. Add `i18n/<locale>/*.ts` with every key of `en` (the `satisfies Record<keyof typeof en, string>` check enforces this) and register it in `i18n/index.ts`.
3. Plural categories: tables today carry `_one` / `_other`. Russian (`one`, `few`, `many`) and Arabic (`zero`, `one`, `two`, `few`, `many`) need extra keys such as `files.count_few`; widen the per-locale table type so those extra keys type-check before translating.
4. Start from the draft glossary below, then have a native speaker review the locale before it ships.
5. Check every page in the new locale, in light and dark and at 375px, as [UI 与交互](ai/change-playbooks.md#ui-与交互) requires, and update the Status table above, [current state](ai/current-state.md) and .

## Right-to-left (Arabic)

Arabic cannot ship until the layout mirrors:

- Set `dir="rtl"` on `<html>`: the sidebar moves to the right, the drawer and task center slide in from the left, list dividers start on the right.
- Replace physical sides with logical properties (`margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `text-align: start`, `border-inline-start`). `styles.css` currently has 43 physical `left` / `right` / `translateX` declarations to convert; slide-in transforms flip sign under `[dir='rtl']`.
- Flip directional icons — `ChevronLeft` / `ChevronRight`, the back link, the "→" in "View instance →" — under `[dir='rtl']`. Do not flip non-directional icons (play, check, settings, the brand mark).
- Keep left-to-right islands: console output and input, code, JVM arguments, file paths, Minecraft commands, ports and versions get `dir="ltr"`; user-supplied names (instances, files) go in `<bdi>`.
- Arabic is a connected script: reset the negative title tracking (`letter-spacing: 0` under `:lang(ar)`) and allow a taller line height (about 1.6 for body text). The system font stack already covers Arabic (SF Arabic, Segoe UI).

## Draft glossary — French, Russian, Spanish, Arabic

Keys are those of `i18n/en/common.ts`. These are drafts with consistent terminology, not reviewed translations.

| Key | en | fr | ru | es | ar |
| --- | --- | --- | --- | --- | --- |
| nav.overview | Instances | Instances | Экземпляры | Instancias | المثيلات |
| nav.workspace | Current Workspace | Espace de travail actuel | Текущая рабочая область | Espacio de trabajo actual | مساحة العمل الحالية |
| nav.deploy | Quick Deploy | Déploiement rapide | Быстрое развёртывание | Despliegue rápido | نشر سريع |
| nav.import | Import Server | Importer un serveur | Импорт сервера | Importar servidor | استيراد خادم |
| nav.multiplayer | Multiplayer | Multijoueur | Сетевая игра | Multijugador | اللعب الجماعي |
| nav.machine | This Machine | Cette machine | Этот компьютер | Este equipo | هذا الجهاز |
| nav.group.servers | Servers | Serveurs | Серверы | Servidores | الخوادم |
| nav.group.maintain | Deploy & Maintain | Déploiement et maintenance | Развёртывание и обслуживание | Despliegue y mantenimiento | النشر والصيانة |
| instance.tab.console | Console | Console | Консоль | Consola | وحدة التحكم |
| instance.tab.files | Files | Fichiers | Файлы | Archivos | الملفات |
| instance.tab.properties | Properties | Propriétés | Параметры | Propiedades | الخصائص |
| instance.tab.settings | Settings | Réglages | Настройки | Ajustes | الإعدادات |
| instance.status.stopped | Stopped | Arrêtée | Остановлен | Detenida | متوقف |
| instance.status.starting | Starting | Démarrage… | Запускается | Iniciando | جارٍ البدء |
| instance.status.running | Running | En cours d'exécution | Работает | En ejecución | قيد التشغيل |
| instance.status.stopping | Stopping | Arrêt en cours | Останавливается | Deteniendo | جارٍ الإيقاف |
| instance.status.crashed | Crashed | Plantée | Сбой | Bloqueada | تعطّل |
| instance.status.migration | Needs Migration | Migration requise | Требуется миграция | Requiere migración | يحتاج إلى ترحيل |
| task.status.pending | Queued | En file d'attente | В очереди | En cola | في قائمة الانتظار |
| task.status.running | In Progress | En cours | Выполняется | En curso | قيد التنفيذ |
| task.status.completed | Completed | Terminé | Завершено | Completado | مكتمل |
| task.status.failed | Failed | Échec | Ошибка | Fallido | فشل |
| action.start | Start | Démarrer | Запустить | Iniciar | تشغيل |
| action.stop | Stop | Arrêter | Остановить | Detener | إيقاف |
| action.restart | Restart | Redémarrer | Перезапустить | Reiniciar | إعادة التشغيل |
| action.forceStop | Force Stop | Forcer l'arrêt | Принудительно остановить | Forzar detención | إيقاف إجباري |
| action.deletePermanently | Delete Permanently | Supprimer définitivement | Удалить навсегда | Eliminar permanentemente | حذف نهائي |
| action.reload | Reload | Recharger | Обновить | Recargar | إعادة التحميل |
| action.cancel | Cancel | Annuler | Отмена | Cancelar | إلغاء |
| action.send | Send | Envoyer | Отправить | Enviar | إرسال |
| action.manage | Manage | Gérer | Управление | Administrar | إدارة |
| action.upload | Upload | Téléverser | Загрузить | Subir | رفع |
| empty.instances.title | No Minecraft instances yet | Aucune instance Minecraft pour l'instant | Пока нет экземпляров Minecraft | Todavía no hay instancias de Minecraft | لا توجد مثيلات Minecraft بعد |
| empty.instances.body | Download an official core with Quick Deploy, or import an existing server from a folder or ZIP. | Téléchargez un noyau officiel avec Déploiement rapide, ou importez un serveur existant depuis un dossier ou un ZIP. | Скачайте официальное ядро через «Быстрое развёртывание» или импортируйте существующий сервер из папки или ZIP-архива. | Descarga un núcleo oficial con Despliegue rápido o importa un servidor existente desde una carpeta o un ZIP. | نزّل نواة رسمية باستخدام «نشر سريع»، أو استورد خادمًا موجودًا من مجلد أو ملف ZIP. |
| error.instances.load | The instance list is unavailable. Check the panel connection and try again. | La liste des instances est indisponible. Vérifiez la connexion au panneau et réessayez. | Список экземпляров недоступен. Проверьте подключение к панели и повторите попытку. | La lista de instancias no está disponible. Comprueba la conexión con el panel e inténtalo de nuevo. | قائمة المثيلات غير متاحة. تحقّق من الاتصال باللوحة ثم أعد المحاولة. |
