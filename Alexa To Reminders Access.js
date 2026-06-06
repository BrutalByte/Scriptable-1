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

// Single WebView loaded on amazon.com so JS fetch() calls use its cookie jar.
// Scriptable's Request uses a separate cookie store and cannot share
// WebView sessions, so all Amazon API calls go through this WebView.
const sessionView = new WebView()

await main()
Script.complete()

// ─── Verbose logging ─────────────────────────────────────────────────────────

function vlog(msg) {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  console.log(`[${ts}] ${msg}`)
}

// ─── WebView API helpers ──────────────────────────────────────────────────────

// Execute fetch() inside the WebView's JS context so Amazon's session
// cookies are automatically included. Must call loadURL(baseURL) first
// to establish the same-origin context.
async function wvFetch(url, options = {}) {
  const optsJSON = JSON.stringify(options)
  const js = `
    fetch(${JSON.stringify(url)}, ${optsJSON})
      .then(r => r.text())
      .then(t => completion(t))
      .catch(e => completion('__ERROR__:' + e.message))
  `
  const result = await sessionView.evaluateJavaScript(js, true)
  if (typeof result === 'string' && result.startsWith('__ERROR__:')) {
    throw new Error(result.replace('__ERROR__:', ''))
  }
  return result || ''
}

async function fetchListJSON() {
  const url = `${baseURL}/alexashoppinglists/api/getlistitems`
  vlog(`Fetching shopping list: ${url}`)
  const text = await wvFetch(url, { credentials: 'include' })
  vlog(`Response length: ${text.length} chars`)
  const json = JSON.parse(text)
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    vlog(`Unexpected response type (${typeof json}): ${JSON.stringify(json).substring(0, 100)}`)
    return null
  }
  return json
}

async function deleteListItem(item) {
  const url = `${baseURL}/alexashoppinglists/api/deletelistitem`
  await wvFetch(url, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  })
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Load amazon.com into the WebView (establishes same-origin context for
// wvFetch), then attempt the API call. If not authenticated, present the
// WebView so the user can sign in, then try once more.
async function ensureAuthenticated() {
  vlog(`Loading Amazon homepage to establish session context: ${baseURL}`)
  await sessionView.loadURL(baseURL)
  const html = await sessionView.getHTML()
  vlog(`Homepage loaded — sign-in indicator present: ${html.includes(signInKey)}`)

  try {
    const json = await fetchListJSON()
    if (json) { vlog("Already authenticated"); return json }
  } catch (e) {
    vlog(`Initial API attempt failed: ${e.message || e}`)
  }

  vlog("Not authenticated — presenting WebView for sign-in")
  await sessionView.present(false)
  vlog("WebView dismissed — retrying API")

  try {
    const json = await fetchListJSON()
    if (json) { vlog("Authenticated after sign-in"); return json }
    vlog("API still returned non-object after sign-in")
  } catch (e) {
    vlog(`Post-login API attempt failed: ${e.message || e}`)
  }

  return null
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

async function synchronizeReminders(json) {
  vlog(`Looking up reminder list: "${reminderListName}"`)
  try {
    let reminderCalendar = await Calendar.forRemindersByTitle(reminderListName)
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
      if (idx === -1) { vlog("User cancelled list picker"); return }
      reminderCalendar = allLists[idx]
      vlog(`User selected: "${reminderCalendar.title}" — saving to settings`)
      settings.reminderListName = reminderCalendar.title
      fm.writeString(settingsPath, JSON.stringify(settings))
    } else {
      vlog(`Reminder list found: "${reminderCalendar.title}"`)
    }

    vlog(`Scanning ${Object.keys(json).length} list(s) for SHOPPING_LIST...`)
    let listItems = []
    let shoppingListId = null
    for (const listId in json) {
      const list = json[listId]
      vlog(`  List "${listId}" — type: ${list.listInfo ? list.listInfo.listType : 'unknown'}`)
      if (list.listInfo && list.listInfo.listType === 'SHOPPING_LIST') {
        listItems = list.listItems || []
        shoppingListId = listId
        vlog(`Found SHOPPING_LIST: "${list.listInfo.listName || 'Default'}" with ${listItems.length} item(s)`)
        break
      }
    }

    if (!shoppingListId) { vlog("No SHOPPING_LIST found — nothing to sync"); return }
    if (listItems.length === 0) { vlog("Shopping list is empty — nothing to sync"); return }

    vlog(`Fetching existing reminders from "${reminderCalendar.title}"`)
    const allReminders = await Reminder.all([reminderCalendar])
    const incompleteReminders = allReminders.filter(r => !r.isCompleted)
    vlog(`Found ${allReminders.length} reminder(s), ${incompleteReminders.length} incomplete`)

    let created = 0, skipped = 0, deleted = 0, deleteFailed = 0

    for (const item of listItems) {
      if (!item.value) {
        vlog(`Skipping item with missing value: ${JSON.stringify(item)}`)
        continue
      }

      const reminderTitle = item.value.split(' ').map(word => {
        if (word.toLowerCase() === withVar || word.toLowerCase() === withoutVar) {
          return word.toLowerCase()
        }
        return word.charAt(0).toUpperCase() + word.slice(1)
      }).join(' ')

      const reminderExists = incompleteReminders.some(r => r.title === reminderTitle)
      if (!reminderExists) {
        vlog(`Creating reminder: "${reminderTitle}"`)
        const reminder = new Reminder()
        reminder.title = reminderTitle
        reminder.calendar = reminderCalendar
        await reminder.save()
        created++
      } else {
        vlog(`Reminder already exists, skipping: "${reminderTitle}"`)
        skipped++
      }

      vlog(`Deleting item from Alexa: "${item.value}"`)
      try {
        await deleteListItem(item)
        vlog(`Deleted from Alexa: "${item.value}"`)
        deleted++
      } catch (deleteError) {
        vlog(`Failed to delete "${item.value}": ${deleteError.message || deleteError}`)
        deleteFailed++
      }
    }

    vlog(`Sync complete — created: ${created}, skipped: ${skipped}, alexa deleted: ${deleted}, delete failures: ${deleteFailed}`)
  } catch (error) {
    vlog(`Error during synchronization: ${error.message || error}`)
    console.error(error)
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  vlog("=== Alexa To Reminders: starting ===")
  const json = await ensureAuthenticated()
  if (!json) {
    vlog("Could not authenticate — exiting")
    return
  }
  await synchronizeReminders(json)
  vlog("=== Alexa To Reminders: done ===")
}
