# User Guide

**English** · [简体中文](user-guide.zh-CN.md)

This guide explains the panel's features and everyday tasks, page by page. If this is your first time, read [Getting Started](getting-started.md) first. For hands-on walkthroughs of running a server, see [Step-by-Step Tutorials](tutorials.md).

---

## What Does the Panel Do?

Mystry Dashboard runs on **your own computer**. You use a web page to manage several Minecraft **servers** (it doesn't launch the game client). You can download or import servers, start the Java process, read logs, change settings and manage files.

Each instance's files live in `instances/<id>` under the panel's data directory. The panel assigns this folder automatically. You can't move it elsewhere, and you can't browse other folders on the computer. For where the data directory is and how it's laid out, see [Configuration](configuration.md#data-directory).

The panel's default address is `http://127.0.0.1:3000`. It listens on this computer only, so it can't be reached directly from the internet.

---

## Interface Tour

The interface follows Apple's design style: a floating, translucent **sidebar** on the left and the **main content area** on the right. The button group at the top right holds "Task Center", "Language" and "Appearance". Each page starts with a large title. When you scroll down, the title collapses into the top toolbar.

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
│ Username [Sign Out]  │
└──────────────────────┘
```

| Sidebar Entry | Route | What It Does |
|----------|------|------|
| Instances | `/` | Lists all instances, with quick start and stop |
| Current Workspace | `/instances/<instance ID>` | Appears after you open an instance and points to the one you're viewing |
| Quick Deploy | `/deploy` | Downloads and installs a core from the official source |
| Import Server | `/import` | Copies a server from a local import folder, or extracts an uploaded zip into an instance |
| Multiplayer | `/multiplayer` | Opens an instance's game port to friends. You can use your own frp server or open a virtual LAN |
| This Machine | `/nodes` | Shows this computer's system, CPU, memory and number of instances |
| Task Center (top right) | — | Slides in from the right with recent deploy and import tasks. It keeps updating after you leave the deploy page, until each task completes or fails |
| Language (top right) | — | Choose **Auto / English / 简体中文 / 繁體中文**. With Auto, the panel follows your browser language: Traditional Chinese (Taiwan, Hong Kong, Macau) shows 繁體中文, other Chinese shows 简体中文, and every other language shows English. The choice is saved in this browser. You can also switch it at the top right of the sign-in page |
| Appearance (top right) | — | Choose the **Auto / Light / Dark** appearance (Auto follows the system). The choice is saved in this browser |
| Sign Out | — | Signs this browser out |

The top of the instance details page has five tabs: **Console / Files / Properties / Backups / Settings**.

At tablet width (1024 pixels and below), the sidebar collapses into "Open navigation menu" at the top left. At phone width (768 pixels and below), a tab bar with **Overview / Deploy / Import / Join / Machine** also appears at the bottom, and dialogs become sheets that rise from the bottom. Press Escape or click the backdrop to close menus, dialogs and the Task Center.

> When you upgrade from an older version, your saved theme is converted automatically: Mystry Dark/Light → Dark/Light + Mystry Pink, Codex → Green, Grok → Graphite.

---

## Sign-In and Account

On the first run with the launcher, the administrator `admin` is created automatically with a random password, and both are shown in the launcher window. When you run the panel by hand, you create the administrator yourself. See [Set Up Administrator](getting-started.md#set-up-administrator) for the steps. The current version allows only one administrator. After it's created, you can't register a second account.

### Signing In

- Title **"Sign In"** → enter your username and password → **"Sign In"**.
- The sign-in is saved in the current browser and expires after 2 hours by default. After it expires, or after you clear site data, you need to sign in again.
- To change your password, click the key icon at the bottom left, then enter your current password and a new one (at least 12 characters).
- After you change the password, every other browser and device signed in to the panel is signed out right away and has to sign in with the new password. The page where you changed it stays signed in, and an open console reconnects by itself.

### Open the Panel on Another Device

By default the panel only accepts this computer. To open it on a phone or another computer, click **Other Devices** in the top bar (at phone width, use **Open on Another Device** on the **This Machine** page).

- **Direct Access**: for a phone on the same Wi-Fi as this computer, or when this computer has a public IP. Click **Turn On**, then scan the QR code in the dialog with your phone, or type one of the listed addresses into a browser.
  - HTTPS is used by default with a certificate the panel issues itself, so a browser warns that the site is not secure the first time. Choose Advanced, then continue to the site (on iPhone, Show Details, then visit this website). To skip the warning, turn off **Use HTTPS**; the connection is then not encrypted.
  - **Network Adapter** defaults to All Adapters. You can also pick one; the note under each adapter says what it is good for.
  - With **Only Allow Devices on the Same Network** on, only devices on the same network as this computer can open the panel.
  - The first time, Windows may ask whether Node.js can use the network. Choose Allow. If the panel is on a cloud server, also allow the panel port (3000 by default) in the provider's security group. Enter a **Public IP or Domain** and the dialog shows an address that works from outside.
- **Virtual Network**: for a phone on mobile data or another network, when you'd rather not open a port.
  - **Built-in**: click **Turn On** and the panel runs EasyTier (it downloads it the first time). Install the same EasyTier version on an Android phone, click **Show Join Details**, enter the network name, secret and nodes in the app and turn on DHCP. Once it has joined, scan the QR code under **Open the Panel**. The phone shows up under **Joined Devices**. There is no official EasyTier app for iPhone, so use the next option there.
  - **Installed Software**: once this computer and your phone both run the same networking software, such as Tailscale, signed in to the same account, pick its adapter here and click **Turn On**.

When you're done, click **Turn Off** and the panel goes back to accepting only this computer. On a server you manage over SSH, the launcher has the same controls: `remote on`, `remote off`, `remote status`, `remote https off`.

### Security Tips

- Use a strong password. The panel can read and write instance files and start processes, so treat it as a high-privilege tool.
- Don't stay signed in on a public computer.
- Don't send the administrator password, or the secrets and setup token in the config file, to anyone, and don't commit them to a repository.
- If you think someone else knows your password or is signed in to your panel, change the password, or reset it as described in [You Forgot the Administrator Password](#you-forgot-the-administrator-password). Their sign-in stops working right away.

---

## Instances

**Purpose**: see the status of all your servers at a glance and do everyday tasks.

The "This Machine" strip under the title shows host CPU, host memory and free space on the data disk. Below it, each server has one row. After its status comes one sentence about what you can do now, such as "Players can join now" or "This server needs Java 21", followed by the matching next step (Invite Friends, Open Settings, Review EULA, Open Console) and then Start or Stop. Switch between **All**, **Running** and **Issues** at the top right of the list. A running server shows the process's CPU and actual memory use, and the bar beside it compares that memory with "Max Memory", the heap limit set for Java (`-Xmx`). Actual use is usually slightly above that limit; the two are not the same thing. With no instances yet, the page lists three ways to add one: Quick Deploy, Import Server and Create Empty Instance. The first sample shows "Collecting…", and metrics the current system doesn't support show "Unavailable". If monitoring fails, the old values stay on screen, marked as possibly out of date, and you can click "Retry Monitoring".

| Column / Area | Description |
|-----------|------|
| Name | Click anywhere on the row outside its buttons (the row ends with an arrow) to open that instance's details |
| Core | Paper, Fabric, Vanilla, Forge, NeoForge, or "Custom Jar" for a jar you uploaded yourself |
| Version | Minecraft version number (may be `-` for custom imports) |
| Status | A colored badge (see the table below), followed by what you can do now |
| Actions | The next step when there is one (Invite Friends, Open Settings, Review EULA, Open Console, Migrate), then whichever of start/stop is available right now. Restart, Force Stop and Delete are under "More Actions" |

Instance status and metrics refresh automatically every 5 seconds, and pause while you're on another browser tab. At the top right of the page are **Quick Deploy**, **Import Server** and **Create Empty Instance** (for when you upload your own `server.jar`). With no instances yet, these three are listed in the middle of the page instead. If a refresh fails, the last data stays on screen with a note that it may be out of date.

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
- **Restart**: available at any time (it stops, then starts). The confirmation dialog warns about the interruption.
- **Force Stop**: ends the process immediately and may corrupt the world. It asks for confirmation. Try a normal stop first.
- **Delete**: stop the instance first. You have to type the instance name to confirm. It deletes the record in the panel and every file in that instance's folder, and it can't be undone. Legacy external folders are never accessed or deleted.

---

## Quick Deploy (Form Reference)

Downloads files from Mojang / Paper / Fabric / Forge / NeoForge and creates an instance. If downloads are slow or can't connect, go to [Download Source](#download-source) and switch to China Mirrors.

| Field | Description |
|------|------|
| Instance Name | The name shown on the Instances page. Defaults to "My Server" |
| Core Type | Paper / Fabric / Forge / NeoForge / Vanilla. Paper, recommended for beginners, is selected by default |
| Game Version | After you pick a core, the version list loads automatically and the latest release is selected by default |
| Paper Build (Optional) | Paper only. Leave it empty to use the latest build (stable preferred) |
| Loader / Forge / NeoForge Version (Optional) | The mod loader version. Fabric also has an Installer Version. Leave it empty to use the latest stable version |
| JVM Settings | Choose the max memory and an optimization preset. The advanced section lets you set Xms and extra arguments; see [JVM Configurator](#jvm-configurator) |
| Java Runtime | Defaults to "System Default Java". You can also click "Rescan" and choose another installed Java; see [Java Runtime](#java-runtime) |
| Minecraft EULA | Unchecked by default. You must check "I have read and agree to the Minecraft EULA" before you can start deploying. `eula=true` is written at startup |

The beginner guide on the right side of the page explains what each core is for and how to join the server after deploying.

After you click **"Start Deploy"**, a progress bar and status text appear (downloading, extracting, installing and so on). When it finishes, the panel **goes automatically** to the new instance page.

By default the panel runs only one deploy or import task at a time. Other tasks show as "Queued". This is normal, so don't submit again. If the queue is full too, the page tells you to try again later. A single task fails if it runs longer than 30 minutes. You can adjust these limits in [Configuration](configuration.md).

**Forge / NeoForge note**: the panel downloads the official installer and runs it. This can take a long time. Don't close the panel.

### JVM Configurator

Quick Deploy, import, Create Empty Instance and Settings all use the same configurator. In the basic view you only choose the max memory and an optimization preset, and the final arguments are previewed below. In the advanced section you can switch to a manual `Xms` and enter extra arguments.

- **Compatibility First**: generates memory arguments only. `Xms` is set automatically to `min(1 GiB, Xmx)`.
- **G1 Balanced**: on top of the compatibility memory settings, enables G1, parallel reference processing and a 200 ms pause target. Available only when Java 8 / 17 / 21 / 25 has been detected.
- **Paper Aikar**: available only for Paper with a detected Java 8 / 17 / 21 / 25. It sets `Xms=Xmx` automatically and shows a warning below 6 GiB. The UI also shows the frozen version, the review date and the official PaperMC source.

The recommended max memory is about 25% of this computer's total memory, rounded down to a multiple of 512 MiB. It's normally no lower than 2 GiB and no higher than 8 GiB, and it leaves at least 2 GiB for the system. On low-memory machines it can drop to 1 GiB. If memory can't be read, it falls back to 2 GiB.

High resource use, an unverified Java version and too little memory for Paper are only warnings. The following block saving: unclosed quotes, duplicate memory arguments or an `Xms` greater than `Xmx`, conflicting GC arguments, and launch arguments that the panel manages (`-jar`, classpath, module launch, `@argfile`, `nogui` and so on).

---

## Import an Existing Server (Form Reference)

The page offers two methods. Both copy the server into a new managed instance. Neither lets the instance run directly in the original folder.

### Import from a Local Folder

Use this when the server is already set up on the machine that runs the panel but isn't managed by the panel yet:

1. Stop the server normally from its original console and make sure the world has finished saving.
2. Copy the complete server folder to `imports/<folder name>` under the data directory (by default, `data/imports` in the panel folder). Don't copy only the jar. Copy the worlds, plugins, mods and configs along with it.
3. Open **Import Server → Import from a Local Folder** in the sidebar, click **Refresh Folders**, and choose the folder under "Folder to Import".
4. If `user_jvm_args.txt` is found in the root folder, explicitly choose **Use Detected Arguments / Use Panel Recommendation / Custom Configuration**. If parsing failed, you can't use the detected arguments.
5. Check the instance name, core type, Minecraft version, JVM settings and Java runtime, then click **Copy and Import**. The core type and version are filled in from the launch file name (for example, `forge-1.12.2-….jar` fills in Forge and 1.12.2). You can change them if they're wrong. If the core type stays on **Auto-detect**, the panel's detection result is used.
6. Wait for the task to finish and take you to the instance page. Check the files and settings first, then start the server from the panel.

> Don't copy while the original server is still running. The panel can't lock an external process, and copying a running server can give you inconsistent world data.

The panel lists only the top-level folders in `imports`. You can't choose anywhere else on the computer. Before copying, it checks that:

- the folder contains no special files such as symbolic links, directory junctions or device files;
- it isn't another panel instance's folder (one with `.mystry-instance.json` in its root);
- it has no more than 200,000 files and is no larger than 100 GiB in total (adjustable in [Configuration](configuration.md)), and the target disk has enough space.

The panel never changes or deletes the original folder or the copy in `imports`. Once you've confirmed that the new instance runs properly, you can delete the copy in `imports` yourself.

### Upload a ZIP

| Field | Description |
|------|------|
| Server Archive (`.zip`) | Required. Up to 512 MiB by default. The number of entries and the total size after extraction are also limited |
| Instance Name | Filled in after the check succeeds. Same as for deploy |
| Core Type / Minecraft Version | Optional. Used for how the instance is shown and for the Java version hint. The launch file is still detected by the panel |
| JVM Settings | Uses the shared configurator after the check succeeds. If arguments were detected, you must explicitly choose how to handle them |
| Java Runtime | Uses the system default Java by default. You can also choose another Java that the panel has found |
| Minecraft EULA | Unchecked by default. If the original server's `eula.txt` is already accepted, you can leave it unchecked. When checked, `eula=true` is written at startup |

Importing takes two steps:

1. Click **Upload and Check**: the panel checks the ZIP's structure and size, and reads `user_jvm_args.txt` from the root folder (or from the only top-level folder).
2. Confirm the instance, Java and JVM settings, then click **Confirm and Import**. Only then does the background import start.

The check result is kept for 30 minutes. If you refresh, or leave and come back, in the same browser tab, you can carry on and confirm. You can also cancel, which deletes the uploaded temporary file right away. After the result expires or the panel restarts, you need to upload again.

During the import, if the zip contains only a single root folder, it's flattened into the instance root automatically. The panel finds the server jar by itself, or the launch arguments file for modern Forge / NeoForge. If the task queue is full, the page tells you to try again later. The check result is kept, so you don't need to upload again.

---

## Download Source

On the **This Machine** page you can choose where the panel downloads files from. The setting takes effect as soon as you save it. No restart is needed:

- **Official** (default): connects directly to Mojang, PaperMC, FabricMC, Forge, NeoForge and GitHub, and never to any third-party mirror.
- **China Mirrors**: Vanilla, Forge, NeoForge and version lists use [BMCLAPI](https://bmclapidoc.bangbang93.com/), and frp and EasyTier use public GitHub mirrors. Deploying Vanilla still reads the version manifest from Mojang, because the checksums for the mirrored files come from it. If a mirror fails, the panel switches to the official source automatically.

The China mirrors are run by third parties. The panel only uses files whose checksums it can verify. A file that doesn't match is discarded and the next source is tried.

With China Mirrors selected, these still come from the official sources:

- Paper and Fabric server files, because they have no reliable mirror.
- Some files for the Forge and NeoForge installers, so installation can fail if your network can't reach Mojang at all.
- Files the server downloads by itself the first time it starts (such as Fabric's dependencies).

Files already in the local cache aren't downloaded again, so switching the source doesn't affect them.

---

## Java Runtime

The panel doesn't accept a hand-typed Java path. For the Java each game version needs, see [Step-by-Step Tutorials: Install Java](tutorials.md#1-install-java).

In "Quick Deploy" and on the import page, the panel selects a Java that matches the game version: the system default Java if it matches, otherwise an installed Java with the recommended version. After you choose one yourself, it stops changing your choice. In "Quick Deploy", **Start Deploy** is unavailable until the Java in use is the recommended version, and the page says which version it needs. "Settings" for an existing instance never changes the saved Java on its own.

If the recommended Java isn't installed, **Install Java N** appears below the selector (Java 8, 17, 21 and 25 on Windows and Linux x64). The panel downloads the Eclipse Temurin JRE from GitHub, or through a GitHub mirror when the download source is set to the China mirror. Each version is pinned to a fixed release and checked against its SHA-256 before it's used. It's installed into `runtimes/java` in the data directory, added to the Java list and selected. The download runs as a task, so you can follow it in the "Task Center". If it fails, switch the download source or use the "Download It Yourself" link.

By default the panel uses the `java` on the PATH of the environment it runs in, shown in the UI as "System Default Java". You can run `java -version` in the same environment to check its version.

To use another installed Java, click "Rescan" next to **Java Runtime** in "Quick Deploy", on the import page or in "Settings". The panel looks only in `JAVA_HOME` and common install locations, and verifies each one by running it. An entry marked "Unavailable" in the list wasn't found in the latest scan, so you need to choose again. The selected Java is verified once more every time an instance starts and before the Forge / NeoForge installer runs.

When the version doesn't match, the console commonly shows `UnsupportedClassVersionError`, or the server fails to start.

---

## Instance Details

The top shows the instance name, core, version and status, along with **Start / Stop / Restart / Force Stop**. "‹ Instances" at the top left takes you back to the Instances page.

### Console

- Shows the server's output in real time.
- **Type a command + Enter** sends it to the server (the same as the in-game console). "Common Commands" below sends `list`, `save-all` and others with one click. Each command you send shows up in the log in bold white, such as `> list`, followed by the server's reply.
- After the connection drops or you refresh the page, it reconnects automatically and shows the recent output history first.
- The length of a single command and the number of commands you can send per minute are limited. The page tells you when you go over; see [Configuration](configuration.md).
- If it shows "Your session has expired" or "The console connection credentials are invalid", try **signing out and signing in again**.

### Files

You can only work with files inside the current instance's root folder:

| Where | Action |
|------|------|
| Top left | **‹** goes up to the parent folder. The path is shown level by level; click any level to jump straight back to it |
| Top right | **Refresh**, **New Folder** (enter the name in a dialog), **Upload** a file to the current folder |
| Click a folder / text file | Opens the folder, or opens the file for editing |
| "…" at the right of each item | **Download** (files only), **Edit** (text files only), **Rename**, **Delete** |

**Edit** opens the file's content in a dialog. Click **Save** to write it back to disk. Large files and binary files can't be edited online.

Paths are relative to the instance root. Before you change `mods`, `plugins` or world data, it's best to **stop the server first**.

Downloads are saved directly by the browser, so even large files don't fill up the page's memory. By default at most 4 downloads run at the same time. When it's busy, you see "Downloads are busy. Try again later." To copy a whole folder, stop the server and use your system's file manager on the instance folder.

Deleting a file or folder always uses a confirmation dialog. Deleting a folder also deletes everything in it. The dialog shows the path and warns that it can't be undone.

### Properties

- Common `server.properties` keys are shown in the General, Multiplayer & Permissions, World and Performance groups. On/off settings use switches. Keys that aren't listed stay under "Advanced".
- After you save with **Save Properties** in the floating bar at the bottom, you need to **restart the instance** for the changes to take effect (the page says so).
- The page marks unsaved changes, and asks whether to discard them before you leave the page or close the tab.
- It's equivalent to editing the `server.properties` file directly.
- Servers on 1.13 and earlier store difficulty and game mode as numbers. The form still shows names, and writes numbers back when you save.
- Chinese characters in text such as the Server Description become `\uXXXX` when written to the file. Both old and new server versions read this correctly. A description that already turned into garbled text can't be recovered automatically. You need to enter it again.

### Multiplayer

To let friends join this server, open **Multiplayer** under **Deploy & Maintain** in the sidebar, then choose the instance. Once the server has finished loading the world, a notice above the instance console also says "The server is up. You can join now." Click **Invite Friends** to go straight to this page. If you don't want to see the notice again, click the **×** at its end (**Don't Show Again**). The segmented control on the page switches between **Direct Connection**, **Virtual LAN** and **frp Tunnel**, and shows one at a time. Switching doesn't turn off the settings you've already saved under the other methods. The panel only forwards this instance's game port. It doesn't expose the admin pages, and you never have to enter a program path.

- **Direct Connection**: friends connect straight to this computer's address. Use it when friends are on the same Wi-Fi or router as this computer, or when this computer has a public address. The page shows the address to send to your friends. Click **Copy** and send it. There's nothing to install or set up. If this computer has a public IPv6 address, an **IPv6 Address for Friends Elsewhere** also appears below. Friends who aren't nearby can join with it directly if they have IPv6 too. If they can't connect, allow only the game port in your router and don't turn off the router's IPv6 firewall entirely, or use Virtual LAN instead. If this computer has a public IP, such as a cloud server or a machine in a data center, click **This Computer Has a Public IP** at the bottom of the page and enter the public IP or domain. The page then shows the public address with the game port for friends to join directly, plus a checklist. The most common cause of trouble is a cloud security group that doesn't allow the game port. The game port and the panel port are different things: friends only need the game port.
  - The first time the server starts, Windows may ask whether to allow Java to access the network. Choose "Allow".
  - If the computer has several addresses, try the one that starts with `192.168` first.

- **Virtual LAN**: you don't need a public server of your own. Turn it on and send the instructions to your friends. They run the command as it is, then join using the virtual address shown on the page.
  - On Windows, start the panel as administrator. Friends must also run the command as administrator, or the virtual network adapter can't be created.
  - When hole punching fails, traffic is relayed through community-shared nodes, encrypted with the network secret.
  - **Relay nodes**: by default the community-shared nodes are run by volunteers. They can go offline at any time, and may be far from you and your friends. Under **Your Relay Nodes** you can add your own nodes, one per line (for example `tcp://relay.example.com:11010`), or clear **Also use community shared nodes** to use only your own. After changing nodes, send the new instructions to your friends again.
  - **Direct connection**: the panel also opens a direct connection port. Friends who have IPv6 or are on the same LAN can connect without a relay.
  - **Windows Firewall**: the panel adds firewall rules that allow only the game port on the virtual address and the direct connection port, and removes them when the virtual LAN stops. The direct connection rules apply only to the EasyTier program the panel starts. If the panel was closed abnormally, leftover rules are removed the next time it starts. If you once blocked Java in a Windows Firewall prompt, first delete that block rule under "Windows Defender Firewall → Advanced settings → Inbound Rules".
  - Anyone who gets the network secret can enter this virtual LAN and reach the game port. Don't post it publicly.
- **frp Tunnel**: needs an frp server of your own (address, port and token).
  - **Public Port**: friends add the address shown on the page directly in Minecraft's multiplayer menu.
  - **Relayed Intranet** / **Direct Intranet**: download the "friend config" and send it to them. They open it with the official frpc, then connect to `127.0.0.1` on their own computer and the port shown on the page. This file contains the token. Send it only to the people you're playing with.

If the panel can't reach GitHub and downloading the client fails, the page shows the file name and SHA-256 of the official archive. Download that file on any device, from the official page or a mirror, then click **Upload Archive**. The panel installs it only if the SHA-256 matches.

Multiplayer opens only after the instance is started. If `server-ip` in the game config is set to the address of one specific network adapter, clear it first, or connections from outside can't get in.

### Backups

**Back Up Now** packs the whole instance folder into one backup (worlds, configs, mods and plugins are all in it). You can back up while the server is running: the panel first pauses auto-save and writes the world to disk, then turns auto-save back on when packing is done. Players don't have to log off. If the instance is starting or stopping, wait for that to finish.

| Where | Action |
|------|------|
| Top right | **Refresh**, **Upload Backup** (a `.tar.gz` you downloaded earlier; it appears in the list only after it passes verification), **Back Up Now** |
| "…" at the right of each item | **Download**, **Restore**, **Delete** |

Stop the server before you **Restore**. Restoring replaces every file in the instance folder with the backup, and files added since then are deleted. "Back up the current files first" in the dialog is checked by default. It automatically creates a "Before restore" backup first, so you can restore back if you got it wrong. The backup is fully verified first. If the file is damaged or has been altered, the instance folder isn't touched. If the server jar at backup time differs from the current one (for example, you've upgraded since), the server file, core type and version in the panel are also set back to their values from the backup after the restore.

Backups are stored under `backups/` in the data directory by default. You can use `BACKUP_DIR` to put them on another disk; see [Configuration](configuration.md#data-directory). A backup contains only this instance's files. It doesn't include accounts or the instance's settings in the panel. Deleting an instance also deletes its backups by default. If you uncheck "Also delete this instance's backups", the backups stay in `backups/` but no longer appear in the panel. For backing up the whole panel, see [Backup and Migration](tutorials.md#tutorial-8-backup-and-migration).

### Settings

| Field | Description |
|------|------|
| Name | Editable |
| Jar File Name | Relative to the instance folder, such as `server.jar` |
| JVM Settings | Use the shared configurator to change memory, the preset and advanced arguments. A restart is recommended after changes |
| Minecraft EULA | When checked, `eula=true` is written to `eula.txt` on every start. When unchecked, the existing `eula.txt` in the instance folder is kept |
| Install Path | Read-only. Shows the full path of the instance folder. The panel assigns it, and it can't be changed after creation |
| Java Runtime | Defaults to "System Default Java", or choose another Java that the panel has found. You can rescan |

After you click **Save Settings**, the page shows "Settings saved." or the reason it failed. Before you leave the page, it likewise asks whether to discard unsaved changes.

---

## Where Is Data Stored?

The instance list, accounts and task records are in `panel.db` in the data directory. Instance files are in `instances/<id>/`. For the full layout and how to change the location, see [Configuration](configuration.md#data-directory). For how to back up, see [Backup and Migration](tutorials.md#tutorial-8-backup-and-migration).

Deleting an instance deletes everything in that instance's folder. Legacy external folders are not accessed or deleted by the panel.

---

## Adopting a Legacy External Instance

A legacy external instance is one whose database record still points to an old folder and that hasn't been moved into the panel's managed root yet. The panel doesn't access the old folder, and it doesn't move or delete it automatically.

1. Stop the instance, and stop the panel service.
2. Using your operating system's copy tools, copy the whole old external folder to `instances/<id>` under the data directory.
3. Start the panel, open the instance (shown as "▲ Needs Migration" on the Instances page), and click **Complete Migration**.
4. Only after adoption succeeds is the instance handled as a panel-managed folder. The old folder stays yours to keep or manage.

Adoption fails if the target folder is empty, incomplete, doesn't match the ID, or the instance is still running. Don't try to reach the old folder through the Files page in the panel.

---

## Common Problems

### A Deploy or Import Is Stuck

- "Queued" on the page is normal. It keeps refreshing until the task completes or fails.
- Check whether this computer can reach the internet (Mojang, Paper, Fabric, Forge and so on). In mainland China, try switching [Download Source](#download-source) to China Mirrors.
- See which step the progress text stopped at. Forge / NeoForge installs are especially slow.
- The Task Center shows why a task failed. The panel log may have more detailed errors. You can view it with the launcher's `logs` command.

### The Server Exits Right After Starting or Shows "Crashed"

First check whether there's a notice above the **Console**. The panel recognizes the two causes below and gives you the next step directly:

- **You haven't agreed to the Minecraft EULA yet**: the status is "Stopped". Click **Agree and Start** in the notice. You can also check Minecraft EULA in **Settings**.
- **The Java version is too new or too old**: the notice states the Java version this server needs. Click **Download Java** and install it. Then open **Settings**, click **Rescan**, select it, save, and start again.

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

While the panel is running, run the `reset-password` command on the computer that runs the panel: `.\mystryctl.cmd reset-password` for the portable build on Windows, `./mystryctl reset-password` for the portable build on Linux, and `.\PanelManager.cmd reset-password` or `./PanelManager.sh reset-password` for the source build. The window shows a new random password, only once. Run it directly in a terminal window: if its output is redirected to a file or piped, the command refuses and the old password stays valid. After signing in, click the key icon at the bottom left to change it to your own.

Resetting the password signs out every browser and device, including the ones you're using. Open the panel again and sign in with the new password.

If you run the panel by hand without the launcher, this command isn't available. You need to stop the panel and handle the `users` table in `panel.db` in the data directory yourself, or delete `panel.db` and set up again (instance registrations are lost; the instance files on disk remain). When you set up again, you must configure `SETUP_TOKEN` again.

---

## Next Steps

- [Step-by-Step Tutorials](tutorials.md): start a Paper server from scratch, import a zip, multiplayer, modded servers and backups
- [Configuration](configuration.md): config file, security and the data directory
- [API reference](api.md) (Chinese): endpoints and automation
