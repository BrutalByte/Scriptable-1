// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: purple; icon-glyph: magic;
/*
$$$$$$$$$$$$$$$$$$$$$$$
$$$$$$$$$$

Alexa To Reminders Access

Script made by: mvan231
Date made: 2023/10/26

Purpose: To sync alexa reminders to a iOS reminders list. previously IFTTT could do this, but Amazon revoked the Alexa IFTTT integration recently.

Setup:
  - Insert the Amazon base url your country uses (if different from default) in the "baseURL" variable below
  - Insert the name of the desired reminders list in the "reminderListName" line. I use "Grocery and Shopping" with my wife, so i have that name entered.
  - Insert the wording for "Sign In" for the signInKeyvariable below. sometimes this varies based on region
  - For proper naming preference, please use the withVar and withoutVar for your local language to properly set naming of the reminders to be created


When running the first time, the script will check if you are logged in. If not, it will notify and present with login page. After that, the script should run seamlessly.

$$$$$$$$$$
$$$$$$$$$$$$$$$$$$$$$$$

$$$$$$$$$$$$$$$$$$$$$$$
$$$$$$$$$$

Version Info:
v6 had to make update to accomodate slight change on Amazon's end
v5 used code from user andereeicheln0z frok github repo issue linked below to inprove performance
https://github.com/mvan231/Scriptable/issues/25

v6 updated if statement from withVariable to withVar so it works properly

v7 updated to specifically target SHOPPING_LIST type and ignore other lists

$$$$$$$$$$
$$$$$$$$$$$$$$$$$$$$$$$
*/

//set baseURL based on your home country url
const baseURL = 'https://www.amazon.com'

//include the reminder list name exactly as it is in Reminders app — overridden by saved settings
let reminderListName = 'Shopping'

//signInKey should be specific for your language. English uses "Sign in". German uses "Anmelden"
const signInKey = "Sign in"

//withVar below needs to be set to your language's version of the word 'with'
const withVar = "with"

//withoutVar below needs to be set to your language's version of the word 'without'
const withoutVar = "without"

const fm = FileManager.iCloud()
const settingsDir = fm.documentsDirectory() + '/AlexaToReminders/'
const settingsPath = settingsDir + 'settings.json'
if (!fm.fileExists(settingsDir)) fm.createDirectory(settingsDir, false)

let settings = {}
if (fm.fileExists(settingsPath)) {
  settings = JSON.parse(fm.readString(settingsPath))
  vlog(`Loaded settings: ${JSON.stringify(settings)}`)
}
if (settings.reminderListName) {
  reminderListName = settings.reminderListName
  vlog(`Using saved reminder list name: "${reminderListName}"`)
}

await main();
Script.complete();

// ─── Verbose logging ─────────────────────────────────────────────────────────

function vlog(msg) {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  console.log(`[${ts}] ${msg}`)
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function checkIfUserIsAuthenticated() {
  vlog("Checking authentication status...")
  try {
    const url = `${baseURL}/alexashoppinglists/api/getlistitems`;
    const request = new Request(url);
    await request.load();
    const status = request.response.statusCode
    vlog(`Auth check response status: ${status}`)
    if (status >= 200 && status < 300) {
      vlog("Authentication confirmed")
      return true;
    }
    vlog(`Not authenticated (status ${status})`)
    return false;
  } catch (error) {
    vlog(`Auth check threw an error: ${error.message || error}`)
    console.error(error);
    return false;
  }
}

async function makeLogin() {
  vlog(`Loading Amazon login page: ${baseURL}`)
  const url = `${baseURL}`;
  const webView = new WebView();

  try {
    await webView.loadURL(url)
    const html = await webView.getHTML();
    vlog(`Login page loaded — checking for sign-in indicator "${signInKey}"`)
    if (html.includes(signInKey)) {
      vlog("Sign-in page detected — presenting WebView to user")
      await webView.present(false);
      vlog("WebView dismissed — re-checking authentication")
      return await checkIfUserIsAuthenticated();
    }
    vlog("Sign-in indicator not found on homepage — verifying API session directly")
    const apiAuthenticated = await checkIfUserIsAuthenticated()
    if (!apiAuthenticated) {
      vlog("API session not authenticated — loading API URL in WebView to refresh session cookies")
      const apiView = new WebView()
      await apiView.loadURL(`${baseURL}/alexashoppinglists/api/getlistitems`)
      await apiView.present(false)
      vlog("WebView dismissed — re-checking authentication")
      return await checkIfUserIsAuthenticated()
    }
    return true;
  } catch (error) {
    vlog(`makeLogin error: ${error.message || error}`)
    console.error(error);
    return false;
  }
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

async function synchronizeReminders() {
  vlog(`Looking up reminder list: "${reminderListName}"`)
  try {
    let reminderCalendar = await Calendar.forRemindersByTitle(reminderListName);
    if (!reminderCalendar) {
      vlog(`Reminder list "${reminderListName}" not found — fetching all lists`)
      const allLists = await Calendar.forReminders()
      if (!allLists || allLists.length === 0) {
        vlog("No reminder lists found on this device")
        return
      }
      vlog(`Available lists: ${allLists.map(l => l.title).join(', ')}`)
      const alert = new Alert()
      alert.title = "Reminders List Not Found"
      alert.message = `"${reminderListName}" doesn't exist. Pick a list to use:`
      for (const list of allLists) alert.addAction(list.title)
      alert.addCancelAction("Cancel")
      const idx = await alert.presentSheet()
      if (idx === -1) {
        vlog("User cancelled list picker")
        return
      }
      reminderCalendar = allLists[idx]
      vlog(`User selected: "${reminderCalendar.title}" — saving to settings`)
      settings.reminderListName = reminderCalendar.title
      fm.writeString(settingsPath, JSON.stringify(settings))
    } else {
      vlog(`Reminder list found: "${reminderCalendar.title}"`)
    }

    const url = `${baseURL}/alexashoppinglists/api/getlistitems`;
    const deleteUrl = `${baseURL}/alexashoppinglists/api/deletelistitem`;
    vlog(`Fetching Alexa shopping list from: ${url}`)
    const raw = await new Request(url).loadString()
    vlog(`Response length: ${raw.length} chars`)

    let json
    try {
      json = JSON.parse(raw)
    } catch (e) {
      vlog("Response was not valid JSON — Amazon may require re-authentication")
      vlog(`Response preview: ${raw.substring(0, 200)}`)
      return
    }

    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      vlog(`Unexpected response type: ${typeof json} — value: ${JSON.stringify(json).substring(0, 200)}`)
      vlog("Amazon session may have expired — please run the script manually to re-authenticate")
      return
    }

    vlog(`Response parsed successfully — found ${Object.keys(json).length} list(s)`)

    let listItems = [];
    let shoppingListId = null;

    for (const listId in json) {
      const list = json[listId];
      vlog(`Inspecting list ID "${listId}" — type: ${list.listInfo ? list.listInfo.listType : 'unknown'}`)
      if (list.listInfo && list.listInfo.listType === "SHOPPING_LIST") {
        listItems = list.listItems || [];
        shoppingListId = listId;
        vlog(`Found SHOPPING_LIST: "${list.listInfo.listName || 'Default Shopping List'}" with ${listItems.length} item(s)`)
        break;
      }
    }

    if (!shoppingListId) {
      vlog("No SHOPPING_LIST found in the response — nothing to sync")
      return;
    }

    if (listItems.length === 0) {
      vlog("Shopping list is empty — nothing to sync")
      return;
    }

    vlog(`Fetching existing reminders from "${reminderCalendar.title}"`)
    const allReminders = await Reminder.all([reminderCalendar]);
    const incompleteReminders = allReminders.filter(r => !r.isCompleted)
    vlog(`Found ${allReminders.length} reminder(s), ${incompleteReminders.length} incomplete`)

    let created = 0, skipped = 0, deleted = 0, deleteFailed = 0

    for (const item of listItems) {
      if (!item.value) {
        vlog(`Skipping item with missing value: ${JSON.stringify(item)}`)
        console.error(`Skipping Alexa list item with missing value: ${JSON.stringify(item)}`);
        continue;
      }

      const reminderTitle = item.value.split(' ').map(word => {
        if (word.toLowerCase() === withVar || word.toLowerCase() === withoutVar) {
          return word.toLowerCase();
        } else {
          return word.charAt(0).toUpperCase() + word.slice(1);
        }
      }).join(' ');

      const reminderExists = incompleteReminders.some(r => r.title === reminderTitle);

      if (!reminderExists) {
        vlog(`Creating reminder: "${reminderTitle}"`)
        const reminder = new Reminder();
        reminder.title = reminderTitle;
        reminder.calendar = reminderCalendar;
        await reminder.save();
        created++
      } else {
        vlog(`Reminder already exists, skipping: "${reminderTitle}"`)
        skipped++
      }

      vlog(`Deleting item from Alexa list: "${item.value}"`)
      const request = new Request(deleteUrl);
      request.method = "DELETE";
      request.headers = { "Content-Type": "application/json" };
      request.body = JSON.stringify(item);

      try {
        await request.loadString();
        vlog(`Deleted from Alexa: "${item.value}"`)
        deleted++
      } catch (deleteError) {
        vlog(`Failed to delete "${item.value}" from Alexa: ${deleteError.message || deleteError}`)
        console.error(`Failed to delete item: ${item.value}`);
        console.error(deleteError);
        deleteFailed++
      }
    }

    vlog(`Sync complete — created: ${created}, skipped: ${skipped}, alexa deleted: ${deleted}, delete failures: ${deleteFailed}`)
  } catch (error) {
    vlog(`Error during synchronization: ${error.message || error}`)
    console.error(error);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  vlog("=== Alexa To Reminders: starting ===")
  const isAuthenticated = await checkIfUserIsAuthenticated();
  vlog(`authenticated? ${isAuthenticated}`);

  if (!isAuthenticated) {
    vlog("Initiating login flow")
    const loggedIn = await makeLogin();
    vlog(`loggedIn? ${loggedIn}`);
    if (!loggedIn) {
      vlog("Login failed — exiting")
      return;
    }
  }

  await synchronizeReminders();
  vlog("=== Alexa To Reminders: done ===")
}
