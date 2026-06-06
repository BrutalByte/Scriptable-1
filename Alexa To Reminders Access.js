// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: purple; icon-glyph: magic;
/*
Alexa To Reminders Access
Script made by: mvan231 — Date: 2023/10/26

Syncs your Alexa shopping list to an iOS Reminders list.
Amazon revoked the IFTTT integration, so this script fills that gap.

Setup:
  1. Set baseURL to your country's Amazon domain if not amazon.com
  2. Set reminderListName to match your Reminders list exactly
     (will prompt to pick one if it doesn't match)
  3. Run once — a login WebView will appear if needed.
     After signing in, tap Done. The script reads your
     session cookies from the WebView and uses them for
     all future API calls via Scriptable's Request object.

Version history:
  v8 — Rewrote auth: extracts session cookies from WebView after login
        and injects them into Request headers. Eliminates all cookie
        store mismatch issues between WebView and Request.
*/

// ─── Configuration ────────────────────────────────────────────────────────────

const baseURL       = 'https://www.amazon.com'
const signInKey     = 'Sign in'
const withVar       = 'with'
const withoutVar    = 'without'

// Overridden by saved settings if present
let reminderListName = 'Shopping'

// ─── Settings ─────────────────────────────────────────────────────────────────

const fm          = FileManager.iCloud()
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

await main()
Script.complete()

// ─── Logging ──────────────────────────────────────────────────────────────────

function vlog(msg) {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  console.log(`[${ts}] ${msg}`)
}

// ─── Cookie extraction ────────────────────────────────────────────────────────

// After a WebView login, extract the amazon.com session cookies via JS
// and return them as a Cookie header string for use in Request objects.
async function extractCookiesFromWebView(webView) {
  vlog('Extracting session cookies from WebView...')
  const js = `
    (function() {
      return document.cookie
    })()
  `
  try {
    const cookieStr = await webView.evaluateJavaScript(js)
    vlog(`Extracted ${cookieStr ? cookieStr.split(';').length : 0} cookie(s)`)
    return cookieStr || ''
  } catch (e) {
    vlog(`Cookie extraction failed: ${e.message || e}`)
    return ''
  }
}

// ─── Amazon API ───────────────────────────────────────────────────────────────

async function apiGet(path, cookieHeader) {
  const url = `${baseURL}${path}`
  vlog(`GET ${url}`)
  const req = new Request(url)
  if (cookieHeader) req.headers = { Cookie: cookieHeader }
  const text = await req.loadString()
  vlog(`Response: ${text.length} chars — preview: ${text.substring(0, 80)}`)
  return text
}

async function apiDelete(path, body, cookieHeader) {
  const url = `${baseURL}${path}`
  vlog(`DELETE ${url}`)
  const req = new Request(url)
  req.method = 'DELETE'
  req.headers = {
    'Content-Type': 'application/json',
    ...(cookieHeader ? { Cookie: cookieHeader } : {})
  }
  req.body = JSON.stringify(body)
  return req.loadString()
}

function parseListResponse(text) {
  let json
  try {
    json = JSON.parse(text)
  } catch (e) {
    vlog(`Response is not valid JSON: ${e.message}`)
    return null
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    vlog(`Unexpected response type (${typeof json}): ${JSON.stringify(json).substring(0, 100)}`)
    return null
  }
  return json
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Try the API with the given cookie header. Returns parsed JSON or null.
async function tryFetch(cookieHeader) {
  try {
    const text = await apiGet('/alexashoppinglists/api/getlistitems', cookieHeader)
    return parseListResponse(text)
  } catch (e) {
    vlog(`API request failed: ${e.message || e}`)
    return null
  }
}

// Show Amazon in a WebView, wait for the user to sign in, then extract
// cookies and return them as a header string.
async function loginAndGetCookies() {
  vlog('Presenting Amazon WebView for sign-in...')
  const wv = new WebView()
  await wv.loadURL(baseURL)
  await wv.present(false)
  vlog('WebView dismissed — extracting cookies')
  return extractCookiesFromWebView(wv)
}

async function ensureAuthenticated() {
  // Try with no extra cookies first (may already be authenticated via system)
  vlog('Attempting API without extra cookies...')
  let json = await tryFetch(null)
  if (json) { vlog('Authenticated via system session'); return { json, cookieHeader: null } }

  // Try with saved cookies from a previous login
  if (settings.cookieHeader) {
    vlog('Trying saved session cookies...')
    json = await tryFetch(settings.cookieHeader)
    if (json) { vlog('Authenticated via saved cookies'); return { json, cookieHeader: settings.cookieHeader } }
    vlog('Saved cookies expired')
  }

  // Need fresh login
  const cookieHeader = await loginAndGetCookies()
  if (cookieHeader) {
    settings.cookieHeader = cookieHeader
    fm.writeString(settingsPath, JSON.stringify(settings))
    vlog('Saved fresh cookies to settings')
  }

  json = await tryFetch(cookieHeader || null)
  if (json) { vlog('Authenticated after login'); return { json, cookieHeader } }

  vlog('Authentication failed — could not get valid API response')
  return null
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

async function synchronizeReminders(json, cookieHeader) {
  vlog(`Looking up reminder list: "${reminderListName}"`)
  try {
    let reminderCalendar = await Calendar.forRemindersByTitle(reminderListName)
    if (!reminderCalendar) {
      vlog(`Reminder list "${reminderListName}" not found — fetching all lists`)
      const allLists = await Calendar.forReminders()
      if (!allLists || allLists.length === 0) { vlog('No reminder lists on device'); return }
      vlog(`Available lists: ${allLists.map(l => l.title).join(', ')}`)
      const alert = new Alert()
      alert.title = 'Reminders List Not Found'
      alert.message = `"${reminderListName}" doesn't exist. Pick a list:`
      for (const list of allLists) alert.addAction(list.title)
      alert.addCancelAction('Cancel')
      const idx = await alert.presentSheet()
      if (idx === -1) { vlog('User cancelled'); return }
      reminderCalendar = allLists[idx]
      vlog(`User selected: "${reminderCalendar.title}" — saving`)
      settings.reminderListName = reminderCalendar.title
      fm.writeString(settingsPath, JSON.stringify(settings))
    } else {
      vlog(`Reminder list found: "${reminderCalendar.title}"`)
    }

    vlog(`Scanning ${Object.keys(json).length} list(s) for SHOPPING_LIST...`)
    let listItems = [], shoppingListId = null
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

    if (!shoppingListId) { vlog('No SHOPPING_LIST found — nothing to sync'); return }
    if (listItems.length === 0) { vlog('Shopping list is empty — nothing to sync'); return }

    vlog(`Fetching existing reminders from "${reminderCalendar.title}"`)
    const allReminders = await Reminder.all([reminderCalendar])
    const incompleteReminders = allReminders.filter(r => !r.isCompleted)
    vlog(`${allReminders.length} total, ${incompleteReminders.length} incomplete`)

    let created = 0, skipped = 0, deleted = 0, deleteFailed = 0

    for (const item of listItems) {
      if (!item.value) { vlog(`Skipping item with no value: ${JSON.stringify(item)}`); continue }

      const reminderTitle = item.value.split(' ').map(word => {
        if (word.toLowerCase() === withVar || word.toLowerCase() === withoutVar) return word.toLowerCase()
        return word.charAt(0).toUpperCase() + word.slice(1)
      }).join(' ')

      if (incompleteReminders.some(r => r.title === reminderTitle)) {
        vlog(`Already exists, skipping: "${reminderTitle}"`)
        skipped++
      } else {
        vlog(`Creating reminder: "${reminderTitle}"`)
        const reminder = new Reminder()
        reminder.title = reminderTitle
        reminder.calendar = reminderCalendar
        await reminder.save()
        created++
      }

      vlog(`Deleting from Alexa: "${item.value}"`)
      try {
        await apiDelete('/alexashoppinglists/api/deletelistitem', item, cookieHeader)
        vlog(`Deleted: "${item.value}"`)
        deleted++
      } catch (e) {
        vlog(`Delete failed for "${item.value}": ${e.message || e}`)
        deleteFailed++
      }
    }

    vlog(`Done — created: ${created}, skipped: ${skipped}, deleted: ${deleted}, delete failures: ${deleteFailed}`)
  } catch (error) {
    vlog(`Sync error: ${error.message || error}`)
    console.error(error)
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  vlog('=== Alexa To Reminders: starting ===')
  const auth = await ensureAuthenticated()
  if (!auth) {
    vlog('Could not authenticate — exiting')
    return
  }
  await synchronizeReminders(auth.json, auth.cookieHeader)
  vlog('=== Alexa To Reminders: done ===')
}
