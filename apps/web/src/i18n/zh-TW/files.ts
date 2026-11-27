import type en from '../en/files';

/** 文件管理文案（繁體中文）。 */
export default {
  'files.validation.nameEmpty': '名稱不能為空',
  'files.validation.nameSeparator': '名稱裡不能有 / 或 \\',
  'files.validation.folderNameEmpty': '資料夾名稱不能為空',
  'files.validation.folderNameSeparator': '資料夾名稱裡不能有 / 或 \\',
  'files.rename.sameName': '新名稱與目前名稱相同',
  'files.download.busy': '下載忙碌中，請稍後再試一次',

  'files.menu.downloading': '下載中…',
  'files.row.open': '開啟 {name}',
  'files.row.edit': '編輯 {name}',
  'files.row.actions': '{name} 的操作',
  'files.row.preparingDownload': '正在準備下載…',
  'files.row.folderMeta': '資料夾 · {modified}',

  'files.nav.parent': '上一層資料夾',
  'files.nav.breadcrumbs': '目前路徑',
  'files.nav.root': '根目錄',

  'files.toolbar.refreshLabel': '重新整理檔案清單',
  'files.toolbar.newFolder': '新增資料夾',
  'files.toolbar.uploading': '上傳中…',

  'files.list.errorWithStale': '{error} 目前仍顯示上次成功載入的檔案清單。',
  'files.list.retrying': '正在重試…',
  'files.list.reload': '重新載入',
  'files.list.loading': '正在載入檔案清單…',
  'files.list.saved': '檔案已儲存。',
  'files.empty.title': '這個資料夾是空的。',
  'files.empty.body': '你可以上傳檔案，或新增一個資料夾。',

  'files.edit.title': '編輯檔案',
  'files.edit.closeLabel': '關閉編輯',
  'files.edit.contentLabel': '檔案內容：{path}',
  'files.edit.binaryReadOnly': '這是二進位檔案，儲存會把它弄壞，所以這裡只能檢視。',
  'files.edit.discard.title': '要捨棄尚未儲存的修改嗎？',
  'files.edit.discard.body': '這個檔案還有尚未儲存的修改，現在關閉會遺失已更改的內容。',
  'files.edit.discard.confirm': '捨棄修改',
  'files.edit.unsaved.title': '要捨棄尚未儲存的檔案修改嗎？',
  'files.edit.unsaved.savingTitle': '正在儲存檔案…',
  'files.edit.unsaved.description': '離開目前頁面會遺失檔案編輯器中尚未儲存的修改。',

  'files.rename.hint': '只能在同一個資料夾內重新命名，名稱裡不能有 / 或 \\。',
  'files.rename.newName': '新名稱',
  'files.rename.renaming': '重新命名中…',

  'files.mkdir.location': '將建立在「/{path}」下。',
  'files.mkdir.name': '資料夾名稱',
  'files.mkdir.placeholder': '例如 plugins',
  'files.mkdir.creating': '建立中…',
  'files.mkdir.create': '建立',

  'files.delete.folderTitle': '刪除資料夾「{name}」？',
  'files.delete.fileTitle': '刪除檔案「{name}」？',
  'files.delete.folderBody': '將刪除資料夾「/{path}」及其中所有檔案，且無法復原。',
  'files.delete.fileBody': '將刪除檔案「/{path}」，且無法復原。',
  'files.delete.deletingFolder': '正在刪除資料夾…',
  'files.delete.deletingFile': '正在刪除檔案…',
  'files.delete.confirm': '確認刪除',
} satisfies Record<keyof typeof en, string>;
