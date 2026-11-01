'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Trap for the pipeline tests: assembly must copy plugin files without ever
// running package scripts from the plugin repository.
fs.writeFileSync(
  path.join(__dirname, '..', '.postinstall-ran'),
  'executed by postinstall\n',
)
