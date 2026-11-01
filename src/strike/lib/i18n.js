import dict from '../i18n.json'

export function loadDict() {
  return Promise.resolve(dict)
}

export function translate(dictionary, lang, key, vars = {}) {
  let text = dictionary?.[lang]?.[key] ?? dictionary?.en?.[key] ?? key
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value ?? ''))
  }
  return text
}
