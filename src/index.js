process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://c6c35da645064e43b912d69afa9ff1b5@sentry.cozycloud.cc/143'

const {
  BaseKonnector,
  requestFactory,
  log,
  saveFiles,
  errors
} = require('cozy-konnector-libs')
const request = requestFactory({
  debug: true,
  cheerio: false,
  json: false, // Despite the wide use of json in the api, we need querystring params too
  jar: true
})

// const VENDOR = 'edoc'
const appDomain = 'https://app.edocperso.fr'
const appUrl = appDomain + '/api/index.php'

module.exports = new BaseKonnector(start)

async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  const sessionId = await authenticate.bind(this)(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of documents')
  const documentsTree = await parseDocuments(sessionId)
  // console.log(JSON.stringify(documentsTree,null,2))

  // Recursively call this function on the tree of files and directories
  const files = extractFilesAndDirs(documentsTree, '', sessionId)

  log('info', 'Saving data to Cozy')
  await saveFiles(files,
                  fields,
                 )
}

async function authenticate(username, password) {
  const rLogin = await request({
    uri: appUrl,
    method: 'POST',
    qs: { api: 'Authenticate', a: 'doAuthentication' },
    json: { login: username, password }
  })
  if (rLogin.status && rLogin.status == 'success') {
    const sessionId = rLogin.content.loginUrl.split('/').pop()
    return sessionId
  } else if (
    rLogin.status &&
    rLogin.status == 'error' &&
    rLogin.code &&
    rLogin.code == 4
  ) {
    log('error', rLogin)
    throw new Error(errors.LOGIN_FAILED)
  } else {
    log('error', 'Get an unexpected result during login')
    log('error', rLogin)
    throw new Error(errors.VENDOR_DOWN)
  }
}

async function parseDocuments(sessionId) {
  const rDocs = await request({
    uri: appUrl,
    method: 'POST',
    qs: { api: 'User', a: 'getFoldersAndFiles' },
    json: { sessionId }
  })
  if (!rDocs.code && rDocs.code != 0) {
    log('error', 'Get an unexpected result during documents listing')
    log('error', 'rDocs')
    throw new Error(errors.VENDOR_DOWN)
  }
  return rDocs.content
}

function extractFilesAndDirs(docsTree, currentPath, sessionId) {
  let newArray = []
  for (const doc of docsTree) {
    if (doc.type == 'folder') {
      const newPath = currentPath + '/' + doc.name
      newArray = newArray.concat(
        extractFilesAndDirs(doc.children, newPath, sessionId)
      )
    } else if (doc.type == 'file') {
      const file = appendFileData(doc, currentPath, sessionId)
      newArray.push(file)
    }
  }
  return newArray
}

function appendFileData(doc, currentPath, sessionId) {
  return {
    filename: doc.name,
    fileurl: `${appUrl}?api=UserDocument&a=getContentAsGet&sessionId=${sessionId}&documentId=${doc.id}&download=1`,
    subPath: currentPath,
    id: doc.id,
    date: doc.depositDate,
    issuerName: doc.issuerName
  }
}
