process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://598f6318d7ff4f299cbf200032480b22@errors.cozycloud.cc/60'

const {
  BaseKonnector,
  requestFactory,
  log,
  saveFiles,
  errors,
  cozyClient
} = require('cozy-konnector-libs')

const models = cozyClient.new.models
const { Qualification } = models.document

const request = requestFactory({
  // debug: true,
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
  await this.deactivateAutoSuccessfulLogin()
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  const sessionId = await authenticate.bind(this)(fields.login, fields.password)
  await this.notifySuccessfulLogin()
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of documents')
  const documentsTree = await parseDocuments(sessionId)

  // Recursively call this function on the tree of files and directories
  const allFiles = extractFilesAndDirs(documentsTree, '', sessionId)
  const sortedFiles = sortFilesArray(allFiles)

  // Prioritize paylips over standard files
  log('info', 'Saving paylips to Cozy')
  await saveFiles(sortedFiles.paylips, fields, {
    contentType: true, // Make the validation by the file extension
    fileIdAttributes: ['vendorRef'],
    sourceAccount: this.accountId,
    sourceAccountIdentifier: fields.login
    // concurrency: 4
  })

  log('info', 'Saving other files to Cozy')
  await saveFiles(sortedFiles.files, fields, {
    contentType: true, // Make the validation by the file extension
    fileIdAttributes: ['vendorRef'],
    sourceAccount: this.accountId,
    sourceAccountIdentifier: fields.login
    // concurrency: 4
  })
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
      let newPath = currentPath + '/' + doc.name
      // Patching the name of 'Non classés'/'notClassified' Folder as it translated by website
      if (
        doc.name == 'notClassified' &&
        doc.code == 'notClassified' &&
        process.env.COZY_LOCALE &&
        process.env.COZY_LOCALE == 'fr'
      ) {
        newPath = '/' + 'Non classé'
      }
      newArray = newArray.concat(
        extractFilesAndDirs(doc.children, newPath, sessionId)
      )
    } else if (doc.type == 'file') {
      const file = appendFileData(doc, currentPath, sessionId)
      newArray.push(file)
    } // Watchout, you can find some empty element [], the if/elseif discard them
  }
  return newArray
}

function appendFileData(doc, currentPath, sessionId) {
  // Warning:
  //   Some files (manually upload at least) contains extension in name and extension attributs
  //   While some others (auto added like paylips) have no extension in name but only in
  //   extension attribut
  const fixedName = doc.name.endsWith(doc.extension)
    ? doc.name
    : doc.name + '.' + doc.extension

  return {
    filename: fixedName,
    fileurl: `${appUrl}?api=UserDocument&a=getContentAsGet&sessionId=${sessionId}&documentId=${doc.id}&download=1`,
    vendorRef: doc.id,
    subPath: currentPath,
    fileAttributes: {
      date: doc.depositDate,
      issuerName: doc.issuerName,
      metadata: {
        contentAuthor: 'edocperso.fr',
        carbonCopy: true,
        electronicSafe: true,
        issueDate: new Date(),
        qualification: Qualification.getByLabel('pay_sheet')
      }
    }
  }
}

// Separate files array to get 'Mes employeurs' Files
function sortFilesArray(array) {
  let paylipsPart = []
  let filesPart = []
  for (const el of array) {
    if (el.subPath.match('^/Mes employeurs')) {
      paylipsPart.push(el)
    } else {
      filesPart.push(el)
    }
  }
  return { paylips: paylipsPart, files: filesPart }
}
