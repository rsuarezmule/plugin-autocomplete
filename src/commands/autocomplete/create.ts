import * as path from 'path'
import * as util from 'util'

import * as fs from 'fs-extra'
import * as _ from 'lodash'

import bashAutocomplete from '../../autocomplete/bash'
import bashAutocompleteWithSpaces from '../../autocomplete/bash-spaces'
import {AutocompleteBase} from '../../base'
import {Interfaces } from '@oclif/core'

const debug = require('debug')('autocomplete:create')

type CommandCompletion = {
  id: string;
  description: string;
  flags: any;
}

function sanitizeDescription(description?: string): string {
  if (description === undefined) {
    return ''
  }
  return description
  .replace(/([`"])/g, '\\\\\\$1') // backticks and double-quotes require triple-backslashes
  // eslint-disable-next-line no-useless-escape
  .replace(/([\[\]])/g, '\\\\$1') // square brackets require double-backslashes
  .split('\n')[0] // only use the first line
}

export default class Create extends AutocompleteBase {
  static hidden = true

  static description = 'create autocomplete setup scripts and completion functions'

  private _commands?: CommandCompletion[]

  async run() {
    this.errorIfWindows()
    // 1. ensure needed dirs
    await this.ensureDirs()
    // 2. save (generated) autocomplete files
    await this.createFiles()
  }

  private async ensureDirs() {
    // ensure autocomplete cache dir
    await fs.ensureDir(this.autocompleteCacheDir)
    // ensure autocomplete bash function dir
    await fs.ensureDir(this.bashFunctionsDir)
    // ensure autocomplete zsh function dir
    await fs.ensureDir(this.zshFunctionsDir)
  }

  private async createFiles() {
    await fs.writeFile(this.bashSetupScriptPath, this.bashSetupScript)
    await fs.writeFile(this.bashCompletionFunctionPath, this.bashCompletionFunction)
    await fs.writeFile(this.zshSetupScriptPath, this.zshSetupScript)
    await fs.writeFile(this.zshCompletionFunctionPath, this.zshCompletionWithSpacesFunction)
  }

  private get bashSetupScriptPath(): string {
    // <cachedir>/autocomplete/bash_setup
    return path.join(this.autocompleteCacheDir, 'bash_setup')
  }

  private get zshSetupScriptPath(): string {
    // <cachedir>/autocomplete/zsh_setup
    return path.join(this.autocompleteCacheDir, 'zsh_setup')
  }

  private get bashFunctionsDir(): string {
    // <cachedir>/autocomplete/functions/bash
    return path.join(this.autocompleteCacheDir, 'functions', 'bash')
  }

  private get zshFunctionsDir(): string {
    // <cachedir>/autocomplete/functions/zsh
    return path.join(this.autocompleteCacheDir, 'functions', 'zsh')
  }

  private get bashCompletionFunctionPath(): string {
    // <cachedir>/autocomplete/functions/bash/<bin>.bash
    return path.join(this.bashFunctionsDir, `${this.cliBin}.bash`)
  }

  private get zshCompletionFunctionPath(): string {
    // <cachedir>/autocomplete/functions/zsh/_<bin>
    return path.join(this.zshFunctionsDir, `_${this.cliBin}`)
  }

  private get bashSetupScript(): string {
    const setup = path.join(this.bashFunctionsDir, `${this.cliBin}.bash`)
    const bin = this.cliBinEnvVar
    /* eslint-disable-next-line no-useless-escape */
    return `${bin}_AC_BASH_COMPFUNC_PATH=${setup} && test -f \$${bin}_AC_BASH_COMPFUNC_PATH && source \$${bin}_AC_BASH_COMPFUNC_PATH;
`
  }

  private get zshSetupScript(): string {
    return `
fpath=(
${this.zshFunctionsDir}
$fpath
);
autoload -Uz compinit;
compinit;\n`
  }

  private get commands(): CommandCompletion[] {
    if (this._commands) return this._commands

    const plugins = this.config.plugins
    const cmds: CommandCompletion[] = []

    plugins.forEach(p => {
      p.commands.forEach(c => {
        try {
          if (c.hidden) return
          const description = sanitizeDescription(c.description || '')
          const flags = c.flags
          cmds.push({
            id: c.id,
            description,
            flags,
          })
          c.aliases.forEach(a => {
            cmds.push({
              id: a,
              description,
              flags,
            })
          })
        } catch (error: any) {
          debug(`Error creating zsh flag spec for command ${c.id}`)
          debug(error.message)
          this.writeLogFile(error.message)
        }
      })
    })

    this._commands = cmds

    return this._commands
  }

  private genZshFlagSpecs(Klass: any): string {
    return Object.keys(Klass.flags || {})
    .filter(flag => Klass.flags && !Klass.flags[flag].hidden)
    .map(flag => {
      const f = (Klass.flags && Klass.flags[flag]) || {description: ''}
      const isBoolean = f.type === 'boolean'
      const name = isBoolean ? flag : `${flag}=-`
      const valueCmpl = isBoolean ? '' : ':'
      const completion = `--${name}[${sanitizeDescription(f.description)}]${valueCmpl}`
      return `"${completion}"`
    })
    .join('\n')
  }

  /* eslint-disable no-useless-escape */
  private get genAllCommandsMetaString(): string {
    return this.commands.map(c => {
      return `\"${c.id.replace(/:/g, '\\:')}:${c.description}\"`
    }).join('\n')
  }
  /* eslint-enable no-useless-escape */

  private get genCaseStatementForFlagsMetaString(): string {
    // command)
    //   _command_flags=(
    //   "--boolean[bool descr]"
    //   "--value=-[value descr]:"
    //   )
    // ;;
    return this.commands.map(c => {
      return `${c.id})
  _command_flags=(
    ${this.genZshFlagSpecs(c)}
  )
;;\n`
    }).join('\n')
  }

  private genCmdPublicFlags(Command: CommandCompletion): string {
    const Flags = Command.flags || {}
    return Object.keys(Flags)
    .filter(flag => !Flags[flag].hidden)
    .map(flag => `--${flag}`)
    .join(' ')
  }

  private get bashCommandsWithFlagsList(): string {
    return this.commands.map(c => {
      const publicFlags = this.genCmdPublicFlags(c).trim()
      return `${c.id} ${publicFlags}`
    }).join('\n')
  }

  private get bashCompletionFunction(): string {
    const cliBin = this.cliBin
    const bashScript = this.config.topicSeparator === ' ' ? bashAutocompleteWithSpaces : bashAutocomplete
    return bashScript.replace(/<CLI_BIN>/g, cliBin).replace(/<BASH_COMMANDS_WITH_FLAGS_LIST>/g, this.bashCommandsWithFlagsList)
  }


  private get zshCompletionWithSpacesFunction(): string {
    const argTemplate = `        "%s")\n          %s\n        ;;\n`

    // TODO:
    // * include command aliases
    const commands = this.config.commands
      .filter(c => !c.hidden)
      .map(c=>{
        c.description = sanitizeDescription(c.summary || c.description || '')
        return c
      })
      .sort((a, b) => {
        if (a.id < b.id) {
          return -1;
        }
        if (a.id > b.id) {
          return 1;
        }
        return 0;
      });

    let topics = this.config.topics.filter((topic: Interfaces.Topic) => {
      // it is assumed a topic has a child if it has children
      const hasChild = this.config.topics.some(subTopic => subTopic.name.includes(`${topic.name}:`))
      return hasChild
    })
      .sort((a, b) => {
        if (a.name < b.name) {
          return -1;
        }
        if (a.name > b.name) {
          return 1;
        }
        return 0;
      })
      .map(t=> {
        return {
          name: t.name,
          description: sanitizeDescription(t.description)
        }
      })

    // alternative name: tommands
    const cotopics=[]
    
    for (const cmd of commands) {
      for (const topic of topics) {
        if (cmd.id === topic.name) {
          cotopics.push(cmd.id)
        }
      }
    }
    console.log(cotopics)


    const genZshFlagArgumentsBlock = (flags?: { [name: string]: Interfaces.Command.Flag; }): string => {
      // if a command doesn't have flags make it only complete files
      if (!flags) return '_arguments "*: :_files"'

      const flagNames = Object.keys(flags)

      // `-S`:
      // Do not complete flags after a ‘--’ appearing on the line, and ignore the ‘--’. For example, with -S, in the line:
      // foobar -x -- -y
      // the ‘-x’ is considered a flag, the ‘-y’ is considered an argument, and the ‘--’ is considered to be neither.
      let argumentsBlock = '_arguments -S \\\n'

      for (const flagName of flagNames){
        const f = flags[flagName]
        f.summary = sanitizeDescription(f.summary || f.description)

        let flagSpec = ''

        if (f.type ==='option') {
          if (f.char) {
            if (f.multiple) {
              // this flag can be present multiple times on the line
              flagSpec += `"*"{-${f.char},--${f.name}}`
            } else {
              flagSpec += `"(-${f.char} --${f.name})"{-${f.char},--${f.name}}`
            }

            flagSpec += `"[${f.summary}]`

            if (f.options) {
              flagSpec += `:${f.name} options:(${f.options?.join(' ')})"`
            } else {
              flagSpec += ':file:_files"'
            }
          } else {
            if (f.multiple) {
              // this flag can be present multiple times on the line
              flagSpec += '"*"'
            }

            flagSpec += `--${f.name}"[${f.summary}]:`

            if (f.options) {
              flagSpec += `${f.name} options:(${f.options.join(' ')})"`
            } else {
              flagSpec += 'file:_files"'
            }
          }
        } else {
          // Flag.Boolean
          if (f.char) {
            flagSpec += `"(-${f.char} --${f.name})"{-${f.char},--${f.name}}"[${f.summary}]"`
          } else {
            flagSpec+=`--${f.name}"[${f.summary}]"`
          }
        }

        flagSpec += ' \\\n'
        argumentsBlock += flagSpec
      }
      // complete files if `-` is not present on the current line
      argumentsBlock+='"*: :_files"'

      return argumentsBlock 
    }

    const genZshValuesBlock = (subArgs: {arg: string, summary?: string}[]): string => {
      let valuesBlock = '_values "completions" \\\n'

      subArgs.forEach(subArg => {
        valuesBlock += `"${subArg.arg}[${subArg.summary}]" \\\n`
      })

      return valuesBlock
    }

    const genZshTopicCompFun = (id: string): string => {
      const underscoreSepId = id.replace(/:/g,'_')
      const depth = id.split(':').length

      let argsBlock = ''
      
      const subArgs: {arg: string, summary?: string}[] = []
      topics
        .filter(t => t.name.startsWith(id + ':') && t.name.split(':').length === depth + 1)
        .forEach(t => {
          const subArg = t.name.split(':')[depth]

          subArgs.push({
            arg: subArg,
            summary: t.description
          })

          argsBlock+= util.format(argTemplate,subArg,`_${this.cliBin}_${underscoreSepId}_${subArg}`) 
        })

      commands
        .filter(c => c.id.startsWith(id + ':') && c.id.split(':').length === depth + 1)
        .forEach(c => {
          const subArg = c.id.split(':')[depth]

          subArgs.push({
            arg: subArg,
            summary: c.description
          })

          const flagArgsTemplate = `        "%s")\n          %s\n        ;;\n`
          argsBlock+= util.format(flagArgsTemplate,subArg,genZshFlagArgumentsBlock(c.flags)) 
        })

      const topicCompFunc =
`_${this.cliBin}_${underscoreSepId}() {
  local context state state_descr line
  typeset -A opt_args

  _arguments -C "1: :->cmds" "*::arg:->args"

  case "$state" in
    cmds)
%s
      ;;
    args)
      case $line[1] in
%s
      esac
      ;;
  esac 
}
`

      return util.format(topicCompFunc, genZshValuesBlock(subArgs), argsBlock)
    }

    const compFunc =
`#compdef ${this.cliBin}

${topics.map(t=> genZshTopicCompFun(t.name)).join('\n')}

_${this.cliBin}() {
  local line state

  _arguments -C "1: :->cmds" "*::arg:->args"

  case "$state" in
      cmds)
          _values "${this.cliBin} command" \\
                  "deploy[deploy]" \\
                  "data[data]" \\
                  "alias[alias]" \\
                  "community[community]" \\
                  "config[config]" \\
                  "env[env]" \\
                  "generate[generate]" \\
                  "info[info]" \\
                  "limits[limits]" \\
                  "login[login]" \\
                  "logout[logout]" \\
                  "org[org]" \\
                  "plugins[plugins]" \\
                  "retrieve[retrieve]" \\
                  "run[run]" \\
                  "object[object]" \\
                  "update[update]" \\
                  "whoami[whoami]" \\
          ;;
      args)
          case $line[1] in
              data)
                  _sf_data
                  ;;
              deploy)
                  _sf_deploy
                  ;;
              alias)
                  _sf_alias
                  ;;
              community)
                  _sf_community
                  ;;
              config)
                  _sf_config
                  ;;
              env)
                  _sf_env
                  ;;
              generate)
                  _sf_generate
                  ;;
              info)
                  _sf_info
                  ;;
              limits)
                  _sf_limits
                  ;;
              login)
                  _sf_login
                  ;;
              logout)
                  _sf_logout
                  ;;
              org)
                  _sf_org
                  ;;
              plugins)
                  _sf_plugins
                  ;;
              retrieve)
                  _sf_retrieve
                  ;;
              run)
                  _sf_run
                  ;;
              object)
                  _sf_sobject
                  ;;
              update)
                  _sf_update
                  ;;
              whoami)
                  _sf_whoami
                  ;;
          esac
          ;;
  esac
}

_${this.cliBin}
`
  return compFunc
  }
  private get zshCompletionFunction(): string {
    const cliBin = this.cliBin
    const allCommandsMeta = this.genAllCommandsMetaString
    const caseStatementForFlagsMeta = this.genCaseStatementForFlagsMetaString

    return `#compdef ${cliBin}

_${cliBin} () {
  local _command_id=\${words[2]}
  local _cur=\${words[CURRENT]}
  local -a _command_flags=()

  ## public cli commands & flags
  local -a _all_commands=(
${allCommandsMeta}
  )

  _set_flags () {
    case $_command_id in
${caseStatementForFlagsMeta}
    esac
  }
  ## end public cli commands & flags

  _complete_commands () {
    _describe -t all-commands "all commands" _all_commands
  }

  if [ $CURRENT -gt 2 ]; then
    if [[ "$_cur" == -* ]]; then
      _set_flags
    else
      _path_files
    fi
  fi


  _arguments -S '1: :_complete_commands' \\
                $_command_flags
}

_${cliBin}
`
  }
}
