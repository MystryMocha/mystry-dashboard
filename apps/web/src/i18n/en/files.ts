/** 文件管理文案（英文主表）。 */
export default {
  'files.validation.nameEmpty': 'Enter a name.',
  'files.validation.nameSeparator': "The name can't contain path separators.",
  'files.validation.folderNameEmpty': 'Enter a folder name.',
  'files.validation.folderNameSeparator': "The folder name can't contain path separators.",
  'files.rename.sameName': 'The new name is the same as the current name.',
  'files.download.busy': 'Downloads are busy. Try again later.',

  'files.menu.downloading': 'Downloading…',
  'files.row.open': 'Open {name}',
  'files.row.edit': 'Edit {name}',
  'files.row.actions': 'Actions for {name}',
  'files.row.preparingDownload': 'Preparing download…',
  'files.row.folderMeta': 'Folder · {modified}',

  'files.nav.parent': 'Parent Folder',
  'files.nav.breadcrumbs': 'Current Path',
  'files.nav.root': 'Root',

  'files.toolbar.refreshLabel': 'Refresh File List',
  'files.toolbar.newFolder': 'New Folder',
  'files.toolbar.uploading': 'Uploading…',

  'files.list.errorWithStale': '{error} The file list from the last successful load is still shown.',
  'files.list.retrying': 'Retrying…',
  'files.list.reload': 'Load Again',
  'files.list.loading': 'Loading files…',
  'files.list.saved': 'File saved.',
  'files.empty.title': 'This folder is empty',
  'files.empty.body': 'Upload a file or create a folder.',

  'files.edit.title': 'Edit File',
  'files.edit.closeLabel': 'Close Editor',
  'files.edit.contentLabel': 'File content: {path}',

  'files.rename.hint': "You can only rename within the same folder. Path separators aren't allowed.",
  'files.rename.newName': 'New Name',
  'files.rename.renaming': 'Renaming…',

  'files.mkdir.location': 'The folder will be created in "/{path}".',
  'files.mkdir.name': 'Folder Name',
  'files.mkdir.placeholder': 'For example, plugins',
  'files.mkdir.creating': 'Creating…',
  'files.mkdir.create': 'Create',

  'files.delete.folderTitle': 'Delete Folder "{name}"?',
  'files.delete.fileTitle': 'Delete File "{name}"?',
  'files.delete.folderBody': 'This deletes the folder "/{path}" and everything in it. This can\'t be undone.',
  'files.delete.fileBody': 'This deletes the file "/{path}". This can\'t be undone.',
  'files.delete.deletingFolder': 'Deleting folder…',
  'files.delete.deletingFile': 'Deleting file…',
  'files.delete.confirm': 'Delete',
} satisfies Record<string, string>;
