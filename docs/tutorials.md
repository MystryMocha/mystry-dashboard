# Step-by-Step Tutorials

**English** · [简体中文](tutorials.zh-CN.md)

These tutorials cover the most common tasks. Follow the steps as written and you'll get there. If you haven't installed the panel yet, read [Getting Started](getting-started.md) first. For a full description of every page and field, see the [User Guide](user-guide.md).

---

## Tutorial 1: Your First Server (Paper Recommended)

Best for: you're using the panel on this computer for the first time and want a small server that friends can join, quickly.

### 1. Install Java

A Minecraft server needs Java. You don't have to install it ahead of time: when you deploy or import a server, the panel picks an installed Java that matches the game version. If there isn't one, it shows an **Install Java N** button. On Windows and Linux (x64), clicking it downloads Eclipse Temurin, checks it and selects it for you.

To install Java yourself instead, use the version that matches the game version you want to run:

| Game version | Java required |
|---|---|
| 26.1 and later (year-based version numbers) | Java 25 |
| 1.20.5 – 1.21.x | Java 21 |
| 1.17 – 1.20.4 | Java 17 |
| 1.16.5 and earlier | Java 8 |

After installing, you can run `java -version` in a terminal to confirm. It's fine to have several Java versions on your computer. You can choose one in the panel when you deploy.

### 2. Start the Panel and Sign In

1. Start the panel:
   - **Portable build (recommended)**: after extracting, on Windows double-click `mystryctl.cmd`. The panel runs in the background, and the window shows the account and important logs. Closing the window doesn't affect the panel or your servers. To stop the panel, double-click to open the window again and press `Ctrl+C`. On Linux, run `./mystryctl start` in the extracted folder. You don't need to install Node.js.
   - **Source build**: install Node.js 22 or later first. On Windows, double-click `PanelManager.cmd` in the repository root. On Linux / WSL, run `./PanelManager.sh start`. The first run installs dependencies and builds automatically, which takes a few minutes.
2. The launcher generates the configuration and opens your browser. If the browser doesn't open, go to `http://127.0.0.1:3000` yourself.
3. On the first run, the launcher creates the administrator `admin` with a random password and shows them in the launcher window. The password is shown only this once, so note it down right away.
4. The page shows "Sign In". Enter the username and password from the window, then click "Sign In".
5. After signing in, open **Panel Settings** (the gear at the bottom left), click **Change Password** and change the password to your own (at least 12 characters). If you forget it, run the `reset-password` command while the panel is running (for example `.\mystryctl.cmd reset-password` for the portable build on Windows). The window shows a new password.

Don't send the password, the config file, or screenshots that contain them to anyone. To write the configuration by hand or run in development mode, see [Getting Started](getting-started.md#manual-install-and-first-time-configuration).

### 3. Deploy Paper with Quick Deploy

1. Click **Quick Deploy** on the left (or **Quick Deploy** in the middle of the Instances page while you have no instances yet).
2. The page already has **Paper** selected (recommended for beginners, supports plugins) along with the latest release game version. Usually you only need:
   - **Instance Name**: for example `My Survival Server`.
   - **Game Version**: if you and your friends want a different version, pick it in the dropdown. The game client version must match it.
   - **Java Runtime**: the panel selects an installed Java that matches the game version. If you see **Install Java 21** (or another version), click it, confirm, and wait for it to finish. You can cancel while it downloads. The new Java is selected automatically. **Start Deploy** stays unavailable until the Java in use matches the recommended version. If the download fails, switch the download source to the China mirror and try again, or install Java yourself as described in [Step 1](#1-install-java).
   - Check **I have read and agree to the Minecraft EULA**. You can't start deploying without it.
3. Leave **Paper Build**, memory and the optimization preset at their defaults. An empty build field uses the latest build (stable preferred), and memory is recommended from your computer's total memory.
4. Click **Start Deploy** and wait for the progress bar to reach 100%. The task may be queued first. The page keeps showing its status until it completes or fails, so don't submit it again. You can also leave the page and follow the progress in the "Task Center" at the top right.
5. When it finishes, you're taken to that instance's page automatically. The panel stores instance files in the `instances` folder of the data directory. You don't need to choose an install location, and you can't.

> Deploying Forge / NeoForge works in a similar way, but it downloads and runs the official installer, so it takes longer. See [Tutorial 4](#tutorial-4-deploy-a-forge-or-neoforge-modded-server).

### 4. Start the Server

1. Click **Start** at the top of the instance page.
2. Switch to **Console** and wait for output like `Done (xx.xxxs)! For help, type "help"`. A status badge that says "Running" only means the process has started. You can join once you see `Done`.
3. If the console reports a wrong Java version (for example `UnsupportedClassVersionError`), go back to [Step 1](#1-install-java) and install the matching Java, then select it in "Settings".

### 5. Test in the Game on the Same Computer

1. Open Minecraft. The version must match the **Game Version** (for a Paper server, join with the matching vanilla version).
2. Multiplayer → Add Server → enter `127.0.0.1` or `localhost` as the address.
3. If you can't connect, check `server-port` on the **Properties** page (default 25565), and make sure no other program on this computer is using that port.

### 6. Let Friends Join (Same LAN)

1. On the **Properties** page, confirm `online-mode=true` (account verification), or change it to suit your needs.
2. Open **Multiplayer** in the sidebar and choose this instance. **Direct Connection** shows the join address (for example `192.168.1.100:25565`). Click **Copy** and send it to them.
3. Your friends add the server in the game and enter that address.

If your friends aren't on the same Wi-Fi or router, switch to **Virtual LAN** or **frp Tunnel** on the Multiplayer page. See [User Guide: Multiplayer](user-guide.md#multiplayer) for the steps.

---

## Tutorial 2: Import an Existing Server from a ZIP

Best for: you downloaded a complete server package somewhere, or packed `server.jar` + configuration + world yourself.

### 1. Prepare the ZIP

- Format: **zip** (not rar / 7z).
- Size: no more than about **512 MiB**, and within the ZIP entry and extraction limits.
- Contents: it should include a runnable server jar (the panel detects it automatically; common names are `server.jar`, `paper.jar` and so on).
- If the zip contains just **one top-level folder** (for example `myserver/server.jar`), it's "flattened" into the instance root directory on import.

### 2. Upload and Import

1. In the sidebar, open **Import Server** and switch to **Upload a ZIP**.
2. Click the selection area and choose the zip file (you can also drag the file onto it), then click **Upload and Check**.
3. After the check passes, fill in the **Instance Name** in **Import Settings** on the right. A ZIP's core and version are detected only during the import, so the summary says "Detected when importing" and notes that the panel can't tell yet whether the Java fits. If you know the version, open **Change Settings** and enter the core and Minecraft version, and the panel recommends a Java for it.
4. If `user_jvm_args.txt` is detected, the panel applies its arguments automatically, and the memory line of the summary says "From user_jvm_args.txt". To skip them, open **Change Settings** and click **Cancel** next to the message. If parsing failed, they aren't applied.
5. Change the Java runtime and the JVM optimization preset in **Change Settings** if needed, and check the EULA box if needed (when the package doesn't already contain `eula=true`).
6. Click **Confirm and Import** and wait for the background task to finish. If the queue is full, the preview is kept and you can confirm again later.

The panel assigns the instance directory automatically. You can't specify it. The check result is kept for 30 minutes, and you can continue confirming after a refresh in the same tab. Cancelling, expiry, or a panel restart deletes the uploaded temporary file.

### 3. Check After Importing

1. Open the instance's **Settings** and confirm that **Jar File Name** matches the actual jar in the directory. A modded server's jar may not be named `server.jar`. Go by what was detected.
2. On the **Files** page, check that `mods`, `config` and so on are complete.
3. Click **Start** and read the log in the console. If it reports a Java version error, install the matching Java as described in [Tutorial 1, Step 1](#1-install-java), then rescan and select it in "Settings".

---

## Tutorial 3: Change the Port, Difficulty and Visibility (server.properties)

1. Open the instance → the **Properties** tab.
2. Common settings:
   - `server-port`: the listening port (restart the instance after changing it).
   - `max-players`: the maximum number of players.
   - `difficulty`: `peaceful` / `easy` / `normal` / `hard`.
   - `gamemode`: `survival` / `creative` and so on.
   - `white-list`: when `true`, only whitelisted players can join (run `whitelist add <PlayerName>` in the console).
   - `online-mode`: whether accounts are verified.
3. After making changes, click **Save Properties**.
4. Click **Restart** on the instance page to apply the configuration (the panel reminds you that changes need a restart).

You can also edit `server.properties` directly in **Files**. The result is the same as using the "Properties" page.

---

## Tutorial 4: Deploy a Forge or NeoForge Modded Server

1. **Quick Deploy** → choose **Forge** or **NeoForge** as the core type.
2. Choose the **Game Version**, then the matching **Forge / NeoForge Version** (the loader dropdown).
3. The page tells you that the official installer has to be downloaded and run first, which **takes longer than other cores**. Keep your network connection stable.
4. After deploying, upload mods to the `mods` folder in **Files** (**Stop** the instance first).
5. If a dependency is missing after starting, the console reports an error. Install the dependency as the mod's instructions say, or switch to a compatible version.

The Java version required is the same as for vanilla. See [Tutorial 1, Step 1](#1-install-java).

---

## Tutorial 5: Manage Players and Permissions from the Console

In the instance's **Console**, type a command and press **Enter** to send it (the same as the in-game console).

| Goal | Example command |
|------|----------|
| Make a player an operator | `op PlayerName` |
| Kick a player | `kick PlayerName` |
| Save the world | `save-all` |
| Whitelist | `whitelist on` / `whitelist add PlayerName` |
| Show help | `help` |

The console keeps the most recent output. After you refresh the page, it shows that earlier output first.

---

## Tutorial 6: Upload a Map or Plugins

### Upload Files to the Instance Directory

1. **Stop** the instance (it's best to stop the server before changing the world or large files).
2. The **Files** tab → go to the target directory (such as `world`, `plugins`, `mods`).
3. Click **Upload** and choose a local file.
4. **New Folder** creates a subdirectory.
5. For text files (such as `ops.json` and some configuration files), click the file name, or click **Edit** in the "…" menu on the right, to edit them online.
6. When you're done, click **Start** or **Restart**.

The Files page only works inside the current instance's root directory. It isn't a file manager for the whole disk.

### Paper Plugins

- Put `.jar` plugins in the `plugins` directory (this needs the Paper core, not plain Vanilla).

---

## Tutorial 7: Manage Multiple Instances

1. The **Instances** list refreshes status automatically every 5 seconds.
2. Each instance has its own process and its own port (set in its own `server.properties`; **don't let two instances use the same port**).
3. From the Instances page you can **Start / Stop / Restart / Delete**:
   - **Delete** asks for confirmation, then deletes every file on disk in that instance's panel-managed directory. This can't be undone.
   - You must **Stop** a running instance before you can delete it.
   - The panel doesn't access or delete legacy external directories.
4. At the bottom of the sidebar you can **Sign Out**. Your sign-in is stored in the current browser.

---

## Tutorial 8: Backup and Migration

### Backup

If you only want to back up one server's world and files, use the **Backups** tab on the instance page. You can back up and restore with one click, even while the server is running. See [User Guide - Backups](user-guide.md#backups). The rest of this section describes how to back up the whole panel, including accounts and instance settings.

First stop all Minecraft instances normally. Then stop the panel through the manager you're using and confirm it has exited. After that, copy the data. Copying world files or the SQLite database while they're in use can give you an inconsistent backup.

We recommend copying the complete data root and the config file used by your current launch entry (see [Configuration](configuration.md)). Keep at least the following:

- `DATA_DIR/panel.db` (instance list and settings)
- The complete `DATA_DIR/instances/<id>/` directory of each instance

If `panel.db-wal` or `panel.db-shm` still exist after stopping, keep them together with the data root. Don't delete them by hand. A backup contains accounts and secrets, so store it somewhere with restricted access. Before restoring, back up the current data first and rehearse with a separate copy.

### Restore on the Same Machine

1. Stop the panel process.
2. Restore `panel.db` and `DATA_DIR/instances/<id>/`, keeping the same `DATA_DIR` and instance IDs.
3. Start the panel and check the instance list. If needed, run **Complete Migration** on the instance page.

### Take Over an Existing Server Outside the Panel

First run `stop` in the original server's console. Then follow [Upload a Folder](user-guide.md#upload-a-folder) to copy it into a panel instance. The panel doesn't delete the original directory.

### Migrate from a Legacy External Directory

Follow [Adopting a Legacy External Instance](user-guide.md#adopting-a-legacy-external-instance): stop the instance and the panel, copy the old directory completely, then click **Complete Migration**.

### Migrate Only the World

On the instance's **Files** page you can download individual files inside `world`. To copy the whole directory, stop the instance (and the panel too, if necessary), then use your system's tools to copy `world` from the managed instance directory.

---

## Still Stuck?

See [User Guide: Common Problems](user-guide.md#common-problems) and [Getting Started: Troubleshooting](getting-started.md#troubleshooting).
