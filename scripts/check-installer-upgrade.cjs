const { _electron: electron } = require('playwright-core')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const [phase, executablePath, fixtureArgument, expectedVersion] = process.argv.slice(2)
assert(['before', 'after'].includes(phase), 'Expected before or after phase')
assert(executablePath && fixtureArgument && expectedVersion, 'Expected executable, fixture folder, and version')
const fixture = path.resolve(fixtureArgument)
const results = path.join(fixture, 'results')
fs.mkdirSync(results, { recursive: true })

async function launch() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath,
    args: env.UPGRADE_SMOKE_APP_ENTRY ? [env.UPGRADE_SMOKE_APP_ENTRY] : [],
    env,
    timeout: 30000
  })
  const version = await app.evaluate(({ app }) => app.getVersion())
  if (version !== expectedVersion) {
    await app.close()
    assert.equal(version, expectedVersion, 'Installed app version')
  }
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  return { app, page }
}

async function snapshot(page) {
  const data = await page.evaluate(async () => ({
    profile: await window.api.getActiveProfileConfig(),
    config: await window.api.getAppConfig(),
    dicomConfig: await window.api.getDicomConfig(),
    marks: await window.api.getExaminerMarks('100123456', 'HD', 1),
    markingState: await window.api.getMarkingState('100123456', 'HD', 1),
    dicomLinks: await window.api.getDicomLinksForStation('100123456', 'HD', 2),
    images: await Promise.all([1, 2].map(station => window.api.getStudentImages('100123456', 'HD', station))),
    references: await Promise.all([1, 2].map(station => window.api.getReferenceImages('HD', station)))
  }))
  const files = {}
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else files[path.relative(fixture, target)] = fs.readFileSync(target).toString('base64')
    }
  }
  visit(data.config.target_root)
  visit(data.config.reference_images_root)
  return { ...data, files }
}

async function seed(app, page) {
  await page.getByText('Set Up This Device', { exact: true }).waitFor()
  await page.evaluate(async fixture => {
    const config = await window.api.getActiveProfileConfig()
    const profile = await window.api.createProfile('Installer upgrade check')
    config.profile = { ...config.profile, id: profile.id, name: profile.name }
    config.modules = config.modules.filter(module => module.code === 'HD')
    config.modules[0].stations = config.modules[0].stations.slice(0, 2)
    config.modules[0].stations[1].form_fields.push({
      ...config.modules[0].stations[1].form_fields.find(field => field.field_type === 'score'),
      field_id: 'CONCLUSION', label: 'Conclusion', sort_order: 99
    })
    config.modules[0].dicom_station_mappings = []
    config.students = [{ student_id: '100123456', full_name: 'Demo Candidate', module_codes: ['HD'] }]
    config.examiners = [{ name: 'Demo Examiner', is_admin: true, module_codes: ['HD'] }]
    await window.api.saveProfileConfig(config)
    await window.api.setActiveProfile(profile.id)
    const configured = await window.api.saveAppConfig({ target_root: fixture + '/assessment', reference_images_root: fixture + '/references' })
    if (!configured.success) throw new Error(configured.error)
    await window.api.configSet('initial_setup_complete', '1')
    await window.api.saveFormMark('100123456', 'HD', 1, 'Demo Examiner', config.modules[0].stations[0].form_fields.map(field => ({
      field_id: field.field_id,
      field_type: field.field_type,
      value_num: field.field_type === 'score' ? field.max_score : null,
      value_text: field.field_type === 'text' ? 'Saved before upgrade' : null
    })))
  }, fixture)
  const samples = await app.evaluate(({ nativeImage }) => ({
    original: nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 125), { width: 32, height: 32 }).toJPEG(90).toString('base64'),
    replacement: nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 210), { width: 32, height: 32 }).toJPEG(90).toString('base64')
  }))
  fs.writeFileSync(path.join(fixture, 'original.jpg'), Buffer.from(samples.original, 'base64'))
  fs.writeFileSync(path.join(fixture, 'replacement.jpg'), Buffer.from(samples.replacement, 'base64'))
  fs.writeFileSync(path.join(fixture, 'replacement.jpeg'), Buffer.from(samples.replacement, 'base64'))
  await page.evaluate(async original => {
    for (const station of [1, 2]) {
      for (const slot of ['img1', 'img2', 'conclusion']) {
        const result = await window.api.copyFileToStation(original, '100123456', 'HD', station, slot)
        if (!result.success) throw new Error(result.reason)
      }
      for (const slot of [1, 2]) {
        const result = await window.api.copyReferenceImage(original, 'HD', station, slot)
        if (!result.success) throw new Error(result.reason)
      }
    }
  }, path.join(fixture, 'original.jpg'))
  const server = http.createServer((request, response) => {
    const parts = new URL(request.url, 'http://127.0.0.1').pathname.split('/').filter(Boolean)
    let data
    if (parts[0] === 'studies') {
      const number = { candidate: 1, reference: 2, conclusion: 3 }[parts[1]]
      data = { MainDicomTags: { StudyInstanceUID: '1.2.826.0.1.3680043.10.999.' + number }, PatientMainDicomTags: { PatientID: '123456-HD-02' }, Series: ['sample-series'] }
    } else if (parts[0] === 'series') {
      data = { Instances: ['sample-1', 'sample-2'], MainDicomTags: { Modality: 'US' } }
    } else if (parts[0] === 'instances' && parts[2] === 'tags') {
      data = { NumberOfFrames: 1 }
    } else if (parts[0] === 'instances' && parts[2] === 'preview') {
      response.setHeader('Content-Type', 'image/jpeg')
      response.end(Buffer.from(samples.original, 'base64'))
      return
    } else {
      response.writeHead(404).end()
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(data))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const linked = await page.evaluate(async base => {
      await window.api.saveDicomConfig({ orthanc_base_url: base, ohif_base_url: base, orthanc_auth_type: 'none' })
      return [
        await window.api.linkDicomStudyToStation('candidate', '100123456', 'HD', 2, false),
        await window.api.linkReferenceDicomStudy('reference', 'HD', 2, 1),
        await window.api.linkConclusionDicomStudy('conclusion', '100123456', 'HD', 2)
      ]
    }, 'http://127.0.0.1:' + server.address().port)
    for (const result of linked) assert.equal(result.success, true, result.error)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
  await page.reload()
  await page.getByRole('button', { name: 'Admin', exact: true }).waitFor()
}

async function checkReplacement(app, page, before) {
  await page.getByRole('button', { name: 'Admin', exact: true }).click()
  await page.getByRole('button', { name: 'Image Audit', exact: true }).click()
  const row = page.getByRole('row').filter({ hasText: 'Demo Candidate' }).filter({ hasText: 'Stn 1' })
  await row.getByText('IMG1_123456.jpg', { exact: true }).waitFor()
  assert.equal(await row.getByRole('button', { name: 'Replace file', exact: true }).count(), 2)
  async function choose(file, slot = 0) {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: !file, filePaths: file ? [file] : [] })
    }, file)
    await row.getByRole('button', { name: 'Replace file', exact: true }).nth(slot).click()
    await row.getByRole('button', { name: 'Replace file', exact: true }).nth(slot).waitFor()
  }
  await choose(null)
  assert.deepEqual(await snapshot(page), before)
  await choose(path.join(fixture, 'replacement.jpg'))
  assert(fs.readFileSync(before.images[0].img1Path).equals(fs.readFileSync(path.join(fixture, 'replacement.jpg'))))
  await choose(path.join(fixture, 'replacement.jpeg'))
  await row.getByText('IMG1_123456.jpeg', { exact: true }).waitFor()
  assert(!fs.existsSync(before.images[0].img1Path))
  await choose(path.join(fixture, 'missing.jpg'))
  await page.getByText(/Failed to link file:/).waitFor()
  const afterFailure = await snapshot(page)
  assert(afterFailure.images[0].img1Path.endsWith('.jpeg'))
  assert(fs.readFileSync(afterFailure.images[0].img1Path).equals(fs.readFileSync(path.join(fixture, 'replacement.jpeg'))))
  assert(fs.readFileSync(before.images[0].img2Path).equals(fs.readFileSync(path.join(fixture, 'original.jpg'))))
  await choose(path.join(fixture, 'replacement.jpeg'), 1)
  await row.getByText('IMG2_123456.jpeg', { exact: true }).waitFor()
  const after = await snapshot(page)
  for (const field of ['profile', 'config', 'dicomConfig', 'marks', 'markingState', 'dicomLinks', 'references']) {
    assert.deepEqual(after[field], before[field], field + ' must remain unchanged')
  }
  assert.deepEqual(after.images[1], before.images[1])
  for (const [file, bytes] of Object.entries(before.files)) {
    if (!/Station 1[\\/]IMG[12]_123456\.jpg$/.test(file)) assert.equal(after.files[file], bytes, file)
  }
  for (const slot of ['img1Path', 'img2Path']) {
    assert(fs.readFileSync(after.images[0][slot]).equals(fs.readFileSync(path.join(fixture, 'replacement.jpeg'))))
  }
  await page.screenshot({ path: path.join(results, 'replacement-controls.png'), fullPage: true })
  return after
}

async function main() {
  let { app, page } = await launch()
  try {
    if (phase === 'before') {
      await seed(app, page)
      const before = await snapshot(page)
      assert(before.marks.length > 0)
      assert.equal(before.dicomLinks.length, 1)
      assert(before.references[1].img1DicomLink)
      assert(before.images[1].conclusionDicomLink)
      fs.writeFileSync(path.join(fixture, 'before.json'), JSON.stringify(before, null, 2))
      console.log('PASS: previous installed version saved local images, reference images, conclusions, marks, profile settings and manual DICOM links.')
    } else {
      await page.getByRole('button', { name: 'Admin', exact: true }).waitFor()
      const before = JSON.parse(fs.readFileSync(path.join(fixture, 'before.json'), 'utf8'))
      assert.deepEqual(await snapshot(page), before, 'Installer upgrade must preserve saved work')
      const after = await checkReplacement(app, page, before)
      await app.close()
      ;({ app, page } = await launch())
      await page.getByRole('button', { name: 'Admin', exact: true }).waitFor()
      assert.deepEqual(await snapshot(page), after, 'Saved work must survive another restart')
      fs.writeFileSync(path.join(results, 'verification.json'), JSON.stringify({
        version: expectedVersion, platform: process.platform, passed: true,
        checks: ['upgrade persistence', 'IMG1 and IMG2 replacement', 'same and different extensions', 'cancellation', 'failed-copy preservation', 'unrelated data unchanged', 'restart persistence']
      }, null, 2))
      console.log('PASS: installed candidate preserves saved work; both replacement controls, cancellation, failure recovery, and restart persistence work.')
    }
  } catch (error) {
    await page.screenshot({ path: path.join(results, phase + '-failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    await app.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
