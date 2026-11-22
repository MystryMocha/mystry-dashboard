# User Guide

**English** · [简体中文](user-guide.zh-CN.md)

This guide covers the panel's features and everyday tasks, page by page. If this is your first time, start with [Getting Started](getting-started.md). For step-by-step walkthroughs of running a server, see [Step-by-Step Tutorials](tutorials.md).

---

## What Does the Panel Do?

Mystry Dashboard runs on **your own computer** and manages several Minecraft **servers** from a web page (it doesn't launch the game client). You can download or import servers, start the Java process, read logs, change settings and manage files.

Each instance's files live in `instances/<id>` under the panel's data directory. The panel assigns this folder automatically; you can't move it elsewhere, and the panel can't browse other folders on the computer. For the data directory's location and layout, see [Configuration](configuration.md#data-directory).

The panel's default address is `http://127.0.0.1:3000`. It listens on this computer only, so it can't be reached directly from the internet.

---

## Interface Tour

The interface follows Apple's design style: a floating, translucent **sidebar** on the left and the **main content area** on the right. The button group at the top right holds "Task Center", "Language" and "Appearance". Each page starts with a large title, which collapses into the top toolbar as you scroll down.

```
┌──────────────────────┐             [Task Center][Language][Appearance]
│ Mystry Dashboard     │  Large title                    [Primary action]
│                      │  Description
│ Servers              │  ───────────────────────────────────
│  [Instances]         │  Main content (cards / grouped lists / console)
│  [Current Workspace] │
│ Deploy & Maintain    │
│  [Quick Deploy]      │
│  [Import Server]     │  ┌ Floating bottom action bar (Save / Start Deploy) ┐
│  [Multiplayer]       │  └──────────────────────────────────────────────────┘
│  [This Machine]      │
│ Username             │
│  [Settings][Sign Out]│
└──────────────────────┘
```

| Sidebar Entry | Route | What It Does |
|----------|------|------|
| Instances | `/` | Lists all instances, with quick start and stop |
| Current Workspace | `/instances/<instance ID>` | Appears after you open an instance and points to the one you're viewing |
| Quick Deploy | `/deploy` | Downloads and installs a core from the official source |
| Import Server | `/import` | Turns an uploaded server folder or zip, or a folder copied into imports, into an instance |
| Multiplayer | `/multiplayer` | Opens an instance's game port to friends, through your own frp server or a virtual LAN |
| This Machine | `/nodes` | Shows this computer's system, CPU, memory and number of instances |
| Panel Settings (the gear at the bottom left) | `/settings` | **This Device**: language and appearance, for this browser only. **Panel**: sign-in duration, download source and Open on Another Device, for every device that signs in. **Account**: change the password or sign out. **Panel Info**: the version, listening address, data folder, backup folder and config file location, read-only; to change them, edit the config file and restart the panel |
| Task Center (top right) | — | Slides in from the right with recent deploy and import tasks, and keeps updating after you leave the deploy page until each task completes or fails. The number on the button counts tasks in progress and is hidden when none are running. A task you cancelled shows as "Cancelled" |
| Language (top right) | — | Choose **Auto / English / 简体中文 / 繁體中文**. With Auto, the panel follows your browser language: Traditional Chinese (Taiwan, Hong Kong, Macau) shows 繁體中文, other Chinese shows 简体中文, and every other language shows English. The choice is saved in this browser and can also be changed at the top right of the sign-in page or in Panel Settings |
| Appearance (top right) | — | Choose the **Auto / Light / Dark** appearance (Auto follows the system). The choice is saved in this browser and can also be changed in Panel Settings |
| Sign Out (bottom left) | — | Signs this browser out. The Account section in Panel Settings has the same button |

The top of the instance details page has five tabs: **Console / Files / Properties / Backups / Settings**.

At tablet width (1024 pixels and below), the sidebar collapses into "Open navigation menu" at the top left. At phone width (768 pixels and below), a tab bar with **Overview / Deploy / Import / Join / Machine** also appears at the bottom, and dialogs become sheets that rise from the bottom. Press Escape or click the backdrop to close menus, dialogs and the Task Center.

> On upgrade from an older version, your saved theme is converted automatically: Mystry Dark/Light → Dark/Light + Mystry Pink, Codex → Green, Grok → Graphite.

---

## Sign-In and Account

On the first run through the launcher, the administrator `admin` is created automatically with a random password, and both are shown in the launcher window. When you run the panel by hand, you create the administrator yourself; see [Set Up Administrator](getting-started.md#set-up-administrator) for the steps. The current version allows only one administrator; once it exists, no second account can be registered.

### Signing In

- Title **"Sign In"** → enter your username and password → **"Sign In"**.
- The sign-in is saved in the current browser and expires after 12 hours by default. After it expires, or after you clear site data, you must sign in again. To change how long it lasts, see [Sign-In Duration](#sign-in-duration).
- To change your password, click the gear at the bottom left to open **Panel Settings**, click **Change Password** under **Account**, then enter your current password and a new one (at least 12 characters).
- Changing the password signs out every other browser and device at once; they must sign in again with the new password. The page where you changed it stays signed in, and an open console reconnects automatically.

### Sign-In Duration

On the **Panel Settings** page, under **Panel**, use **Sign-In Expires After** to choose how long a device stays signed in before the panel asks for the password again: 2 hours, 12 hours (the default), 1 day, 7 days, 30 days or **Never**. The choice is saved at once, with no restart needed:

- Lengthening it applies to this device at once, and to other devices after they next sign in.
- Shortening it means devices signed in for longer than the new duration must sign in again.
- With **Never**, every device that signs in stays signed in until the password changes. Use it with care if **Open on Another Device** is turned on.

### Open the Panel on Another Device

By default the panel accepts connections from this computer only. To open it on a phone or another computer, click **Other Devices** in the top bar (at phone width, use **Open on Another Device** on the **This Machine** page). The **Panel** section of **Panel Settings** has the same entry.

- **Direct Access**: for a phone on the same Wi-Fi as this computer, or when this computer has a public IP. Click **Turn On**, then scan the QR code in the dialog with your phone, or type one of the listed addresses into a browser.
  - HTTPS is used by default with a certificate the panel issues itself, so a browser warns that the site is not secure the first time. Choose Advanced, then continue to the site (on iPhone, Show Details, then visit this website). To skip the warning, turn off **Use HTTPS**; the connection is then unencrypted.
  - **Network Adapter** defaults to All Adapters, or you can pick one; the note under each adapter says when to use it.
  - With **Only Allow Devices on the Same Network** on, only devices on the same network as this computer can open the panel.
  - The first time, Windows may ask whether Node.js can use the network. Choose Allow. If the panel is on a cloud server, also allow the panel port (3000 by default) in the provider's security group. Enter a **Public IP or Domain** and the dialog shows an address that works from outside.
- **Virtual Network**: for a phone on mobile data or another network, when you'd rather not open a port.
  - **Built-in**: click **Turn On** and the panel runs EasyTier (downloading it the first time). Install the same EasyTier version on an Android phone, click **Show Join Details**, enter the network name, secret and nodes in the app and turn on DHCP. Once it has joined, scan the QR code under **Open the Panel**; the phone then appears under **Joined Devices**. There is no official EasyTier app for iPhone; use the next option there.
  - **Installed Software**: once this computer and your phone run the same networking software, such as Tailscale, signed in to the same account, pick its adapter here and click **Turn On**.

When you're done, click **Turn Off** and the panel goes back to accepting only this computer. On a server you manage over SSH, the launcher has the same controls: `remote on`, `remote off`, `remote status`, `remote https off`.

### Security Tips

- Use a strong password. The panel can read and write instance files and start processes, so treat it as a high-privilege tool.
- Don't stay signed in on a public computer.
- Don't share the administrator password, or the secrets and setup token in the config file, with anyone, and don't commit them to a repository.
- If you think someone else knows your password or is signed in to your panel, change the password, or reset it as described in [You Forgot the Administrator Password](#you-forgot-the-administrator-password). Their sign-in stops working at once.

---

## Instances

**Purpose**: see the status of all your servers at a glance and handle everyday tasks.

The "This Machine" strip under the title shows host CPU, host memory and free space on the data disk. Below it, each server has one row: its status; a sentence on what you can do now, such as "Players can join now", "This server needs Java 21" or "The Java chosen for this server is no longer available"; the matching next step (Invite Players, Open Settings, Review EULA, Open Console); then Start or Stop. Switch between **All**, **Running** and **Issues** at the top right of the list. A running server shows the process's CPU and actual memory use; the bar beside it compares that memory with "Max Memory", the heap limit set for Java (`-Xmx`). Actual use is usually slightly above that limit; the two are different measures. With no instances yet, the page lists three ways to add one: Quick Deploy, Import Server and Create Empty Instance. The first sample shows "Collecting…", and metrics the current system doesn't support show "Unavailable". If monitoring fails, the old values stay on screen, marked as possibly out of date, and you can click "Retry Monitoring".

| Column / Area | Description |
|-----------|------|
| Name | Click anywhere on the row outside its buttons (the row ends with an arrow) to open that instance's details |
| Core | Paper, Fabric, Vanilla, Forge, NeoForge, or "Custom Jar" for a jar you uploaded yourself |
| Version | Minecraft version number (may be `-` for custom imports) |
| Status | A colored badge (see the table below), followed by what you can do now |
| Actions | The next step when there is one (Invite Players, Open Settings, Review EULA, Open Console, Migrate), then whichever of start/stop is available now. Restart, Force Stop and Delete are under "More Actions" |

Instance status and metrics refresh automatically every 5 seconds and pause while you're on another browser tab. At the top right of the page are **Quick Deploy**, **Import Server** and **Create Empty Instance** (for uploading your own `server.jar`). With no instances yet, these three are listed in the middle of the page instead. At phone width, Quick Deploy and Import Server are in the bottom tab bar, only Create Empty Instance stays at the top right, and the "This Machine" strip moves below the server list. If a refresh fails, the last data stays on screen with a note that it may be out of date.

### Instance Status

| Shown in the UI | Meaning | What You Can Do |
|----------|------|----------|
| Stopped | No Java process is running | Start it |
| Starting | The process is starting up | Wait |
| Running | The server has started | Join the game, send console commands |
| Stopping | The process is shutting down | Wait |
| Crashed | The process exited abnormally | Check the console log to troubleshoot |
| ▲ Needs Migration | A legacy external instance that hasn't been adopted yet | See [Adopting a Legacy External Instance](#adopting-a-legacy-external-instance) |

**Button behavior**

- **Start**: available only when the instance isn't "Running".
- **Stop**: available only when the instance isn't "Stopped".
- **Restart**: stops, then starts; the confirmation dialog warns about the interruption. Under "More Actions" on the Instances page it's available except while the instance is starting or stopping; at the top of the instance's page it appears only while the instance is running.
- **Force Stop**: ends the process immediately and may corrupt the world; it asks for confirmation. Try a normal stop first. It's available only while the process is alive (starting, running or stopping), under "More Actions".
- **Delete**: stop the instance first, then type its name to confirm. It deletes the panel's record and every file in that instance's folder, and can't be undone. Legacy external folders are never accessed or deleted. Besides "More Actions" on the Instances page, **Delete Instance** is also at the bottom of the instance's **Settings** tab.

---

## Quick Deploy (Form Reference)

Downloads files from Mojang / Paper / Fabric / Forge / NeoForge and creates an instance. If downloads are slow or can't connect, switch to China Mirrors under [Download Source](#download-source).

| Field | Description |
|------|------|
| Instance Name | The name shown on the Instances page. Defaults to "My Server" |
| Core Type | Paper / Fabric / Forge / NeoForge / Vanilla. Paper, recommended for beginners, is selected by default |
| Game Version | After you pick a core, the version list loads automatically and the latest release is selected by default |
| Paper Build (Optional) | Paper only. Leave it empty to use the latest build (stable preferred) |
| Loader / Forge / NeoForge Version (Optional) | The mod loader version. Fabric also has an Installer Version. Leave it empty to use the latest stable version |
| JVM Settings | Enter the initial and max memory and choose an optimization preset. The advanced section takes extra arguments; see [JVM Configurator](#jvm-configurator) |
| Java Runtime | Defaults to "System Default Java". You can also click "Rescan" and choose another installed Java; see [Java Runtime](#java-runtime) |
| Minecraft EULA | Unchecked by default. You must check "I have read and agree to the Minecraft EULA" before you can start deploying. `eula=true` is written at startup |

The beginner guide on the right side of the page explains what each core is for and how to join the server after deploying.

After you click **"Start Deploy"**, a progress bar and status text appear (downloading, extracting, installing and so on). When it finishes, the panel **goes automatically** to the new instance page.

By default the panel runs only one deploy or import task at a time. Other tasks show as "Queued"; this is normal, so don't submit again. If the queue is also full, the page asks you to try again later. A single task fails if it runs longer than 30 minutes. You can adjust these limits in [Configuration](configuration.md).

**Forge / NeoForge note**: the panel downloads and runs the official installer, which can take a long time. Don't close the panel.

### JVM Configurator

Quick Deploy, import, Create Empty Instance and Settings all use the same configurator. In the basic view you enter the initial memory (`Xms`) and the max memory (`Xmx`) side by side, with common sizes under each (2 / 4 / 6 GB for the initial memory and 8 / 10 / 12 GB for the max memory, hiding any that exceed this computer's memory), and choose an optimization preset next to them (or below them when space is narrow). The small arrows at the right of each memory box, or the ↑ and ↓ keys in the box, change it by 1 GB. Until you change the initial memory, the preset sets it; once you change it, it no longer follows the max memory. The **Advanced JVM Arguments** section holds the extra arguments and the final arguments preview, and opens automatically when there are extra arguments or errors.

- **Compatibility First**: generates memory arguments only. The initial memory is set automatically to 1 GiB, or to the max memory if that's smaller.
- **G1 Balanced**: enables G1, parallel reference processing and a 200 ms pause target. Available only when Java 8 / 17 / 21 / 25 has been detected. Switching to it sets the initial memory to match the max memory, and it keeps following the max memory until you change it yourself.
- **Paper Aikar**: available only for Paper with a detected Java 8 / 17 / 21 / 25. The initial memory is locked to match the max memory, and a warning appears below 6 GiB. The UI also shows the frozen version, the review date and the official PaperMC source.

The recommended max memory is about 25% of this computer's total memory, rounded down to a multiple of 512 MiB. It's normally between 2 GiB and 8 GiB, and it leaves at least 2 GiB for the system. On low-memory machines it can drop to 1 GiB; if memory can't be read, it falls back to 2 GiB.

High resource use, an unverified Java version and too little memory for Paper are only warnings. The following block saving: unclosed quotes, duplicate memory arguments or an `Xms` greater than `Xmx`, conflicting GC arguments, and launch arguments that the panel manages (`-jar`, classpath, module launch, `@argfile`, `nogui` and so on).

---

## Import an Existing Server (Form Reference)

The page offers three methods. Each copies the server into a new managed instance; none lets the instance run directly in the original folder.

Until a source is ready, the page shows only the source column. Once the upload is checked (or a usable folder in imports is selected), **Import Settings** appears on the right (below on narrow screens): the instance name, the server the panel recognized (core and version), the Java and maximum memory it will use, and the EULA checkbox. The core type, Minecraft version, Java runtime and JVM settings are in **Change Settings**, which you don't need to open when the recognized values are right. **Change Settings** opens automatically when the Java version doesn't match, no usable Java is found, the JVM arguments have an error or warning, or `user_jvm_args.txt` can't be used, and closes again when you switch to another source. When the Minecraft version isn't known yet (for example with a ZIP, whose version is detected only during the import), the summary says the panel can't tell whether the Java fits; you can enter the version in **Change Settings**.

### Upload a Folder

Choose the server's folder in your browser. This works whether the server is on the computer that runs the panel or on another computer where you've opened the panel's web page:

1. Stop the server normally from its original console and make sure the world has finished saving. A running server holds files such as `session.lock` open, and the browser can't read them.
2. Open **Import Server → Upload a Folder** in the sidebar, click **Choose Folder**, and choose the level that holds the whole server (the one with `server.jar` or `run.bat` inside). You can also drag the folder onto the box. When your browser asks whether to upload these files to the site, click Upload.
3. Click **Upload and Check**. The browser sends the files to the panel in batches, and the progress bar shows how many have been sent. You can click **Cancel Upload** at any time. When all files have arrived, the panel looks for the launch file and reads `user_jvm_args.txt` from the root folder, following the same rules as "Copy from imports" below.
4. Check the instance name and the recognized values in **Import Settings**. To change the core type, version, Java or memory, open **Change Settings**. Then click **Confirm and Import**.

- The panel receives only the file contents and their paths inside the folder. It can't see or record where the folder is on your computer, and the original folder isn't changed.
- Uploaded files are first kept in `uploads` under the data directory. When you confirm, the whole folder is moved into the new instance, so it doesn't take up space twice.
- A checked folder is kept for 30 minutes, and refreshing in the same browser tab lets you continue. Cancelling, expiry or a panel restart deletes it. If you refresh in the middle of an upload, you must start over.
- Browsers upload only files, so empty folders aren't carried over. The server creates the empty folders it needs when it starts.
- The limits on file count and total size are the same as for "Copy from imports". If the data disk doesn't have enough space, you're told at the start.
- If a file can't be read, the page names it. This usually means the original server is still running.
- Most phone browsers can't choose folders, so this option isn't shown there. Upload a ZIP or copy from imports instead.

### Copy from imports

Use this when the server is already on the computer that runs the panel but isn't managed by the panel yet. For example, the panel runs on a server you manage over SSH, so your browser is on another computer and can't reach the server's folder. It also suits very large servers.

This method is normally hidden from the method switch; to use it, click **Switch to Copy from imports** below Upload a Folder. It's listed directly when the `imports` folder already has something in it, or when your browser can't choose folders, such as on a phone. Steps:

1. Stop the server normally from its original console and make sure the world has finished saving.
2. Copy the complete server folder into the `imports` folder, giving each server its own folder directly inside `imports`. The page shows the full path of this folder on the computer that runs the panel (by default, `data/imports` in the panel folder), and **Copy Path** copies it. Don't copy only the jar; include the worlds, plugins, mods and configs. If the server is on your own computer and very large, transfer it to this folder with an SFTP client (such as WinSCP or FileZilla) or rsync, which can resume an interrupted transfer. Uploading a folder through the browser can't resume.
3. Open **Import Server → Copy from imports** in the sidebar and choose the folder under "Servers in imports". If you've just copied it in, click **Refresh** first. Each row shows the core and version the panel recognized, the jar it starts, and whether there's a `user_jvm_args.txt`. A folder whose launch file isn't recognized yet says "Checked on import"; one that can't be imported says why and can't be chosen.
4. If `user_jvm_args.txt` is found in the root folder, the panel applies its arguments automatically. The memory line of the summary says "From user_jvm_args.txt", and a note above the JVM settings in **Change Settings** says so too. To skip it, click **Cancel** there: the arguments revert to what they were before, and you can click **Apply Again** later. If the file can't be parsed, it isn't applied and the message says why. When you switch to another folder, the arguments from the previous folder are reverted.
5. Check the instance name and the recognized values in **Import Settings**, change anything in **Change Settings** if needed, then click **Copy and Import**. The core type and version are filled in from the launch file name (for example, `forge-1.12.2-….jar` fills in Forge and 1.12.2); you can correct them if they're wrong. If the core type stays on **Auto-detect**, the panel's detection result is used.
6. Wait for the task to finish and take you to the instance page. Check the files and settings first, then start the server from the panel.

> Don't copy while the original server is still running. The panel can't lock an external process, and copying a running server can give you inconsistent world data.

The panel lists only the top-level folders in `imports`; you can't choose anywhere else on the computer. Before copying, it checks that:

- the folder contains no special files such as symbolic links, directory junctions or device files;
- it isn't another panel instance's folder (one with `.mystry-instance.json` in its root);
- it has no more than 200,000 files and is no larger than 100 GiB in total (adjustable in [Configuration](configuration.md)), and the target disk has enough space.

The panel never changes or deletes the original folder or the copy in `imports`. Once you've confirmed that the new instance runs properly, you can delete the copy in `imports` yourself.

### Upload a ZIP

| Field | Description |
|------|------|
| Server Archive (`.zip`) | Required. Up to 512 MiB by default. The number of entries and the total size after extraction are also limited |
| Instance Name | Filled in after the check succeeds. Same as for deploy |
| Core Type / Minecraft Version | In **Change Settings**. Optional; used for how the instance is shown and for the Java version hint. The panel still detects the launch file |
| JVM Settings | In **Change Settings**. Uses the shared configurator. If the ZIP has a `user_jvm_args.txt`, it's applied automatically, and you can click **Cancel** |
| Java Runtime | In **Change Settings**. Defaults to the system default Java; you can also choose another Java that the panel has found |
| Minecraft EULA | Unchecked by default. If the original server's `eula.txt` is already accepted, you can leave it unchecked. When checked, `eula=true` is written at startup |

Importing takes two steps:

1. Click **Upload and Check**: the panel checks the ZIP's structure and size, and reads `user_jvm_args.txt` from the root folder (or from the only top-level folder).
2. Check **Import Settings** (open **Change Settings** if needed), then click **Confirm and Import**. Only then does the background import start.

The check result is kept for 30 minutes. If you refresh, or leave and come back, in the same browser tab, you can still confirm. You can also cancel, which deletes the uploaded temporary file at once. After the result expires or the panel restarts, you must upload again.

During the import, if the zip contains only a single root folder, it's flattened into the instance root automatically. The panel finds the server jar on its own, or the launch arguments file for modern Forge / NeoForge. If the task queue is full, the page asks you to try again later; the check result is kept, so you don't need to upload again.

---

## Download Source

On the **Panel Settings** page, under **Panel**, use **Download Source** to choose where the panel downloads files from. The setting takes effect on save, with no restart needed:

- **Official** (default): connects directly to Mojang, PaperMC, FabricMC, Forge, NeoForge and GitHub, and never to any third-party mirror.
- **China Mirrors**: Vanilla, Forge, NeoForge and version lists use [BMCLAPI](https://bmclapidoc.bangbang93.com/), and frp and EasyTier use public GitHub mirrors. Deploying Vanilla still reads the version manifest from Mojang, because the checksums for the mirrored files come from it. If a mirror fails, the panel switches to the official source automatically.

The China mirrors are run by third parties. The panel uses only files whose checksums it can verify; a file that doesn't match is discarded and the next source is tried.

With China Mirrors selected, these still come from the official sources:

- Paper and Fabric server files, because they have no reliable mirror.
- Some files for the Forge and NeoForge installers, so installation can fail if your network can't reach Mojang at all.
- Files the server downloads by itself the first time it starts (such as Fabric's dependencies).

Files already in the local cache aren't downloaded again, so switching the source doesn't affect them.

---

## Java Runtime

The panel doesn't accept a hand-typed Java path. For the Java each game version needs, see [Step-by-Step Tutorials: Install Java](tutorials.md#1-install-java).

In "Quick Deploy" and on the import page, the panel selects a Java that matches the game version: the system default Java if it matches, otherwise an installed Java with the recommended version. Once you choose one yourself, it leaves your choice alone. In "Quick Deploy", **Start Deploy** is unavailable until the Java in use is the recommended version, and the page says which version it needs. "Settings" for an existing instance never changes the saved Java on its own.

The line below the selector shows the status of the Java that will actually be used: the Java you selected from the panel's list (for example, "Java 21.0.5 is available"), or the system default Java when "System Default Java" is selected. When the Java in use isn't the recommended version, "Recommended: Java N" follows it. If the recommended Java isn't installed, the same line also has **Install Java N** (Java 8, 17, 21 and 25 on Windows and Linux x64). Clicking it first asks for confirmation, stating where it downloads from and how big it is. While it downloads, **Cancel Install** next to the progress bar stops it and removes the partial download. The panel downloads the Eclipse Temurin JRE from GitHub, or through a GitHub mirror when the download source is set to the China mirror. Each version is pinned to a fixed release and checked against its SHA-256 before use. It's installed into `runtimes/java` in the data directory, added to the Java list and selected. The download runs as a task, so you can follow it in the "Task Center". If it fails, switch the download source or use the "Download It Yourself" link.

By default the panel uses the `java` on the PATH of the environment it runs in, shown in the UI as "System Default Java". Run `java -version` in the same environment to check its version.

To use another installed Java, click "Rescan" next to **Java Runtime** in "Quick Deploy", on the import page (in **Change Settings**) or in "Settings". The options show only the major version; the path is added only when more than one Java has the same major version. Hover over the list to see the selected Java's path. The panel looks only in `JAVA_HOME` and common install locations, and verifies each one by running it. An entry marked "Unavailable" in the list wasn't found in the latest scan, so you must choose again. The selected Java is verified again every time an instance starts and before the Forge / NeoForge installer runs.

When the version doesn't match, the console commonly shows `UnsupportedClassVersionError`, or the server fails to start.

---

## Instance Details

The top shows the instance name, core, version and status, along with the actions available now: **Start** while it's stopped; **Stop** and **Restart** while it's running, with **Force Stop** under "More Actions" beside them. "‹ Instances" at the top left takes you back to the Instances page.

### Console

- Shows the server's output in real time.
- **Type a command + Enter** sends it to the server (the same as the in-game console). "Common Commands" below sends `list`, `save-all` and others with one click. Each command you send appears in the log in bold white, such as `> list`, followed by the server's reply.
- After the connection drops or you refresh the page, it reconnects automatically and shows the recent output history first.
- The length of a single command and the number of commands you can send per minute are limited, and the page tells you when you go over; see [Configuration](configuration.md).
- If it shows "Your session has expired" or "The console connection credentials are invalid", try **signing out and signing in again**.

### Files

You can work only with files inside the current instance's root folder:

| Where | Action |
|------|------|
| Top left | **‹** goes up to the parent folder. The path is shown level by level; click any level to jump back to it |
| Top right | **Refresh**, **New Folder** (enter the name in a dialog), **Upload** a file to the current folder |
| Click a folder / text file | Opens the folder, or opens the file for editing |
| "…" at the right of each item | **Download** (files only), **Edit** (text files only), **Rename**, **Delete** |

**Edit** opens the file's content in a dialog; click **Save** to write it back to disk. Large files and binary files can't be edited online.

Paths are relative to the instance root. Before you change `mods`, `plugins` or world data, it's best to **stop the server first**.

Downloads are saved directly by the browser, so even large files don't fill up the page's memory. By default at most 4 downloads run at once; when it's busy, you see "Downloads are busy. Try again later." To copy a whole folder, stop the server and use your system's file manager on the instance folder.

Deleting a file or folder always asks for confirmation in a dialog, which shows the path and warns that it can't be undone. Deleting a folder also deletes everything in it.

### Properties

- Common `server.properties` keys are shown in the General, Multiplayer & Permissions, World and Performance groups. On/off settings use switches. Keys that aren't listed stay under "Advanced".
- After you save with **Save Properties** in the floating bar at the bottom, **restart the instance** for the changes to take effect (the page says so).
- The page marks unsaved changes, and asks whether to discard them before you leave the page or close the tab.
- It's equivalent to editing the `server.properties` file directly.
- Servers on 1.13 and earlier store difficulty and game mode as numbers. The form still shows names, and writes numbers back when you save.
- Chinese characters in text such as the Server Description become `\uXXXX` when written to the file, which both old and new server versions read correctly. A description that has already turned into garbled text can't be recovered automatically; enter it again.

### Multiplayer

To let players join this server, open **Multiplayer** under **Deploy & Maintain** in the sidebar, choose the instance at the top left, then use the segmented control next to it to switch between **Direct Connection**, **Virtual LAN** and **frp Tunnel**. One method shows at a time, and switching doesn't turn off settings you've already saved under the others. Once the server has finished loading the world, a notice above the instance console also says "The server is up. You can join now." Click **Invite Players** to go straight to this page. To hide the notice for good, click the **×** at its end (**Don't Show Again**). The panel forwards only this instance's game port; it doesn't expose the admin pages, and you never have to enter a program path.

The **Guide** column on the right explains how the tunnel modes differ and what to check when players can't connect. Once you're familiar with it, click its **×** to close it, and **Show Guide** to bring it back; this browser remembers the choice. On narrow screens the guide sits at the bottom of the page.

- **Direct Connection**: players connect straight to this computer's address. Use it when players are on the same Wi-Fi or router as this computer, or when this computer has a public address. The page shows the **Join Address on the Same Network**; click **Copy** and send it. There's nothing to install or set up.
  - This is a private address: only players on the same router or Wi-Fi as this computer can use it, and players on other networks can't connect with it. For them, choose **Use Virtual LAN** or **Enter Public Address**, right below it.
  - The first time the server starts, Windows may ask whether to allow Java to access the network. Choose "Allow".
  - If the computer has several addresses, try the one that starts with `192.168` first.
  - If this computer has a public IPv6 address, an **IPv6 Join Address** also appears. Players elsewhere who also have IPv6 can join with it directly. If they can't connect, allow only the game port in your router; don't turn off the router's IPv6 firewall entirely.
  - If this computer has a public IP, such as a cloud server or a machine in a data center, click **Enter Public Address** below the join address and enter the public IP or domain. The page then shows the **Public Join Address**, and the guide adds a checklist. The most common cause of trouble is a cloud security group that doesn't allow the game port. The game port and the panel port are different: players need only the game port.

- **Virtual LAN**: you don't need a public server of your own. Turn on **Open This Instance to Players** at the top; it takes effect at once, with no Save step. **Let Players Join** then shows three steps: copy or download the **Join Instructions** and send them to players; players run EasyTier as the instructions say; players join the address shown in the last step. Until EasyTier is installed, the page shows only the download button; the switch appears once it is installed.
  - On Windows, start the panel as administrator. Players must also run the command as administrator, or the virtual network adapter can't be created. When the panel isn't running as administrator, the page says so before EasyTier is downloaded: on the computer running the panel, right-click `mdash.cmd`, choose **Run as administrator**, then choose **Restart the panel** in the menu. Restarting stops running servers, so start them again afterwards. Until then, and whenever the virtual LAN has failed, **Let Players Join** is not shown, so no join instructions that cannot work get sent.
  - When hole punching fails, traffic is relayed through community-shared nodes, encrypted with the network secret.
  - **Relay nodes**: by default the panel uses community-shared nodes run by volunteers. They can go offline at any time, and may be far from you and your players. Expand **Relay Nodes** to add your own nodes under **Your Relay Nodes**, one per line (for example `tcp://relay.example.com:11010`), or clear **Also use community shared nodes** to use only your own, then click **Save Relay Nodes**. After changing nodes, send the new join instructions again.
  - **Direct port**: the panel also opens a direct port, shown at the bottom of the page. Players who have IPv6 or are on the same LAN can connect through it without a relay.
  - **Windows Firewall**: the panel adds firewall rules that allow only the game port on the virtual address and the direct port, and removes them when the virtual LAN stops. The direct port rules apply only to the EasyTier program the panel starts. If the panel was closed abnormally, leftover rules are removed the next time it starts. If you once blocked Java in a Windows Firewall prompt, first delete that block rule under "Windows Defender Firewall → Advanced settings → Inbound Rules".
  - The join instructions contain the network secret. Anyone who gets it can enter this virtual LAN and reach the game port, so don't post it publicly.
- **frp Tunnel**: needs an frp server of your own (address, port and token). Until you add one, the page shows the form for it. Then choose the server, tunnel mode and port and click **Save and Open**. After that, the **Open This Instance to Players** switch at the top turns it on or off, and **Tunnel Settings** (with **Add frp Server**) folds away. The delete button next to the server dropdown deletes the server selected there.
  - With the **Public Port** tunnel mode, players add the join address directly in Minecraft's multiplayer menu, without installing frp.
  - **STCP Relay** / **XTCP P2P**: follow the steps under **Let Players Join** to copy or download the **Player Config** and send it. Players run it with the official frpc, then connect to `127.0.0.1` at the **Port on Player's Computer**. STCP goes through the frp server; XTCP connects directly for lower latency, but some networks block it. This file contains the token; send it only to players who are joining.

If the panel can't reach GitHub and downloading the client fails, click **Install Manually** under the download button to see the file name and SHA-256 of the official archive. Download that file on any device, from the official page or a mirror, then click **Upload Archive**. The panel installs it only if the SHA-256 matches.

Multiplayer opens only after the instance is started. If `server-ip` in the game config is set to the address of one specific network adapter, clear it first, or connections from outside can't get in.

### Backups

**Back Up Now** packs the whole instance folder into one backup, including worlds, configs, mods and plugins. You can back up while the server is running: the panel first pauses auto-save and writes the world to disk, then turns auto-save back on when packing is done, so players don't have to log off. If the instance is starting or stopping, wait for that to finish.

| Where | Action |
|------|------|
| Top right | **Refresh**, **Upload Backup** (a `.tar.gz` you downloaded earlier; it appears in the list only after it passes verification), **Back Up Now** |
| "…" at the right of each item | **Download**, **Restore**, **Delete** |

Stop the server before you **Restore**. Restoring replaces every file in the instance folder with the backup, and files added since then are deleted. "Back up the current files first" in the dialog is checked by default; it first creates a "Before restore" backup automatically, so you can undo a mistaken restore. The backup is fully verified first; if the file is damaged or has been altered, the instance folder isn't touched. If the server jar at backup time differs from the current one (for example, you've upgraded since), the restore also sets the server file, core type and version in the panel back to their values from the backup.

Backups are stored under `backups/` in the data directory by default. You can use `BACKUP_DIR` to put them on another disk; see [Configuration](configuration.md#data-directory). A backup contains only this instance's files, not accounts or the instance's settings in the panel. Deleting an instance also deletes its backups by default. If you uncheck "Also delete this instance's backups", the backups stay in `backups/` but no longer appear in the panel. For backing up the whole panel, see [Backup and Migration](tutorials.md#tutorial-8-backup-and-migration).

### Settings

| Field | Description |
|------|------|
| Name | Editable |
| Jar File Name | Relative to the instance folder, such as `server.jar`. Forge and NeoForge instances show a read-only Launch File here instead: the argument file the panel found when the server was deployed or imported |
| JVM Settings | Use the shared configurator to change memory, the preset and advanced arguments. A restart is recommended after changes |
| Minecraft EULA | When checked, `eula=true` is written to `eula.txt` on every start. When unchecked, the existing `eula.txt` in the instance folder is kept, so an imported server can bring its own agreement. If you uncheck it after it was checked and save, `eula.txt` is changed to `eula=false` |
| Install Path | Read-only. Shows the full path of the instance folder. The panel assigns it, and it can't be changed after creation |
| Java Runtime | Defaults to "System Default Java", or choose another Java that the panel has found. You can rescan |

After you click **Save Settings**, the page shows "Settings saved." or the reason it failed. Before you leave the page, it likewise asks whether to discard unsaved changes.

**Delete Instance** is at the bottom of the tab, under "Danger Zone". Stop the instance first, type its name to confirm, and choose whether to delete its backups too. After deletion you're taken back to the Instances page.

---

## Where Is Data Stored?

The instance list, accounts and task records are in `panel.db` in the data directory. Instance files are in `instances/<id>/`. For the full layout and how to change the location, see [Configuration](configuration.md#data-directory); for how to back up, see [Backup and Migration](tutorials.md#tutorial-8-backup-and-migration).

Deleting an instance deletes everything in that instance's folder. The panel doesn't access or delete legacy external folders.

---

## Adopting a Legacy External Instance

A legacy external instance is one whose database record still points to an old folder and that hasn't been moved into the panel's managed root yet. The panel doesn't access the old folder, and doesn't move or delete it automatically.

1. Stop the instance, and stop the panel service.
2. Using your operating system's copy tools, copy the whole old external folder to `instances/<id>` under the data directory.
3. Start the panel, open the instance (shown as "▲ Needs Migration" on the Instances page), and click **Complete Migration**.
4. Only after adoption succeeds is the instance handled as a panel-managed folder. The old folder stays yours to keep or manage.

Adoption fails if the target folder is empty, incomplete or doesn't match the ID, or if the instance is still running. Don't try to reach the old folder through the Files page in the panel.

---

## Common Problems

### A Deploy or Import Is Stuck

- "Queued" on the page is normal. The page keeps refreshing until the task completes or fails.
- Check whether this computer can reach the internet (Mojang, Paper, Fabric, Forge and so on). In mainland China, try switching [Download Source](#download-source) to China Mirrors.
- See which step the progress text stopped at. Forge / NeoForge installs are especially slow.
- The Task Center shows why a task failed. The panel log may have more detailed errors; view it with the launcher's `logs` command.

### The Server Exits Right After Starting or Shows "Crashed"

First check for a notice above the **Console**. The panel recognizes the causes below and gives you the next step directly:

- **You haven't agreed to the Minecraft EULA yet**: the status is "Stopped". Click **Agree and Start** in the notice, or check Minecraft EULA in **Settings**.
- **The Java version is too new or too old**: the notice states the Java version this server needs. Click **Download Java** and install it. Then open **Settings**, click **Rescan**, select it, save, and start again.
- **The Java you chose is no longer available** (it was uninstalled or moved): the Instances page and the notice above the console say so before you start. Open **Settings**, click **Rescan**, choose a Java again, save, and start.

If there's no notice:

1. Read the last few error lines in the console.
2. Check the Jar File Name and JVM arguments in **Settings**.
3. Make sure the Java in use is available and the version matches; see [Java Runtime](#java-runtime).

### The Game Can't Connect to the Server

- Is the server **Running**, and has `Done` appeared in the console?
- Does **server-port** in `server.properties` match the port entered in the game?
- For a test on this computer, use `127.0.0.1`. On a LAN, use the host's LAN IP. On a cloud server, use the public IP and allow the game port in the security group.
- Does the firewall allow Java or that port?

### You See "Your session has expired"

- **Sign in** again.
- If you run the panel by hand and setting up the administrator fails, make sure you entered the `SETUP_TOKEN` from the current config file, and that no administrator has been created yet.

### A ZIP Import Fails

- Make sure it's a **zip** and no larger than 512 MiB. If it says the size limit is exceeded, use a smaller archive or raise the limit.
- If it says it's busy, wait for the current upload to finish and try again.
- Does the archive contain a server jar (not just a client)?
- If the archive has entries that point to paths outside it, the panel refuses the import.

### You Forgot the Administrator Password

While the panel is running, run the `reset-password` command on the computer that runs the panel: `.\mdash.cmd reset-password` on Windows, and on Linux `./mdash reset-password` for the portable build or `./mdash.sh reset-password` for the source build. On Windows you can also double-click `mdash.cmd` and choose **Reset the administrator password** in the menu; the sign-in page gives the same pointer. The window shows a new random password, only once. Run it directly in a terminal window: if its output is redirected to a file or piped, the command refuses and the old password stays valid. After signing in, open **Panel Settings** (the gear at the bottom left) and click **Change Password** to set your own.

Resetting the password signs out every browser and device, including the ones you're using. Open the panel again and sign in with the new password.

If you run the panel by hand without the launcher, this command isn't available. Stop the panel and handle the `users` table in `panel.db` in the data directory yourself, or delete `panel.db` and set up again (instance registrations are lost; the instance files on disk remain). When you set up again, you must configure `SETUP_TOKEN` again.

---

## Next Steps

- [Step-by-Step Tutorials](tutorials.md): start a Paper server from scratch, import a zip, multiplayer, modded servers and backups
- [Configuration](configuration.md): config file, security and the data directory
- [API reference](api.md) (Chinese): endpoints and automation
