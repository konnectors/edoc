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

const { default: CozyClient } = require('cozy-client')

const models = cozyClient.new.models
const { Qualification } = models.document
const flag = require('cozy-flags/dist/flag').default

const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: false, // Despite the wide use of json in the api, we need querystring params too
  jar: true
})

const appv2Domain = 'https://v2-app.edocperso.fr'
const finalizedUserUrl = `${appv2Domain}/edocPerso/V1/edpUser/finalize`
const appApiDomain = `${appv2Domain}/edocPerso/V1`
const appDocUrl = `${appApiDomain}/edpUser/getFoldersAndFiles`
const appDownloadUrl = `${appApiDomain}/edpDoc/getContent`
const webhookUrl = 'https://v2-app.edocperso.fr/edocPerso/V1/edpUser/setupHook'
// const demoWebhookUrl = `${appApiDomain}/edpUser/setupHook`
const loginUrl =
  'https://edocperso.fr/index.php?api=Authenticate&a=doAuthentication'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await this.deactivateAutoSuccessfulLogin()
  this.client = CozyClient.fromEnv()
  await this.client.registerPlugin(flag.plugin)
  await this.client.plugins.flags.initializing
  const isCreator = flag('edoc.account-creator')
  log('info', `isCreator mode :${JSON.stringify(isCreator)}`)
  let sessionId
  if (isCreator) {
    sessionId = await authenticate.bind(this)('creator')
  }
  sessionId = await authenticate.bind(this)(fields.login, fields.password)
  await this.notifySuccessfulLogin()
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of documents')
  const documentsTree = await parseDocuments(sessionId)

  // Recursively call this function on the tree of files and directories
  const allFiles = extractFilesAndDirs(documentsTree, '', sessionId)
  log('debug', `Found ${allFiles.length} files`)
  const sortedFiles = sortFilesArray(allFiles)
  log('debug', `Sorted ${sortedFiles.paylips.length} payslips files`)
  log('debug', `Sorted ${sortedFiles.files.length} other files`)

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
  if (username === 'creator') {
    log('info', 'Creator mode detected, finalizing user')
    const finalizedUser = await request({
      method: 'POST',
      uri: finalizedUserUrl,
      json: {
        firstName: '[firstName]',
        lastName: '[lastName]',
        activationCode: '[code]', // Activation code sent by email from RH platform
        gender: '[gender]', // Not asked to the user on the website, i assume it is no longer used
        birthdate: '[YYYY-MM-DD]',
        email: '[email]',
        inseeNum: '', // presence is mandatory, but no need to fill it
        phone: '0606060606',
        address: '1 Rue des champs',
        adress: '1 Rue des champs', // Both are mandatory
        zipCode: '75001',
        town: 'Paris',
        login: '[email]',
        password: '[password]',
        securityQuestion: 1, // Can have 1 to 5
        securityAnswer: '[answer]',
        agreedToLastCGU: true,
        isAnAdult: true
      }
    })
    if (finalizedUser.status && finalizedUser.status == 'success') {
      const sessionId = finalizedUser.content.loginUrl.split('/').pop()
      const newWebhook = await this.client
        .collection('io.cozy.triggers')
        .create({
          worker: 'konnector',
          type: '@webhook',
          message: {
            konnector: 'edoc'
          }
        })
      await request({
        method: 'POST',
        uri: webhookUrl,
        headers: {
          Authorization: `Bearer ${sessionId}`,
          'Content-Type': 'application/json;charset=utf-8'
        },
        json: {
          id: 'cozy',
          endpoint: newWebhook.data.links.webhook
        }
      })
      return sessionId
    } else if (finalizedUser.status && finalizedUser.status == 'error') {
      log('error', finalizedUser)
      throw new Error(errors.LOGIN_FAILED)
    }
  } else {
    const rLogin = await request({
      uri: loginUrl,
      method: 'POST',
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
}

async function parseDocuments(sessionId) {
  const rDocs = await request({
    uri: appDocUrl,
    method: 'POST',
    json: { sessionId }
  })
  if (rDocs.status === 'error') {
    log('debug', `error content : ${rDocs.content}`)
  }
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
  let fixedName = doc.name.endsWith(doc.extension)
    ? doc.name
    : doc.name + '.' + doc.extension

  // Files with / in file name fails to download
  fixedName = fixedName.replace(/\//g, '')

  return {
    filename: fixedName,
    fileurl: `${appDownloadUrl}`,
    vendorRef: doc.id,
    subPath: currentPath,
    fileAttributes: {
      date: doc.depositDate,
      issuerName: doc.issuerName,
      metadata: {
        contentAuthor: 'edocperso.fr',
        carbonCopy: true,
        electronicSafe: true,
        issueDate: new Date()
      }
    },
    // Mandatory on new app version
    requestOptions: {
      headers: {
        Accept: 'application/octet-stream',
        'Content-Type': 'application/json;charset=utf-8'
      },
      method: 'POST',
      json: {
        sessionId,
        documentId: doc.id
      }
    }
  }
}

// Separate files array to get 'Mes employeurs' Files
function sortFilesArray(array) {
  let paylipsPart = []
  let filesPart = []
  for (let el of array) {
    if (
      el.subPath.match('^/Mes employeurs') &&
      el.fileAttributes.issuerName != null
    ) {
      // Adding qualification for All Employeurs document as paysheet
      el.fileAttributes.metadata = {
        ...el.fileAttributes.metadata,
        qualification: Qualification.getByLabel('pay_sheet')
      }
      paylipsPart.push(el)
    } else {
      filesPart.push(el)
    }
  }
  return { paylips: paylipsPart, files: filesPart }
}
