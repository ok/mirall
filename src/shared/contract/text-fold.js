// Every text search compares folded text: lowercased and in NFC, so a name that arrives decomposed
// (Finder writes names that way) matches the same name typed composed. NFC is applied last so the
// result is composed whatever the lowercasing emits.
/** @param {string} text @returns {string} */
export function foldSearchText(text) {
  return text.toLowerCase().normalize('NFC')
}
