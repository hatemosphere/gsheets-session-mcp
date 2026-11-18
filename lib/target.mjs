// Parse a sheet reference: a full Google Sheets URL or a bare spreadsheet ID.
// Returns { spreadsheetId, gid } where gid is a string or null if not in the ref.

export function parseSheetRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('spreadsheet must be a URL or ID string');
  const text = ref.trim();

  const idFromUrl = /\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/.exec(text);
  const spreadsheetId = idFromUrl ? idFromUrl[1] : text;
  if (!/^[a-zA-Z0-9_-]+$/.test(spreadsheetId) || spreadsheetId.length < 20) {
    throw new Error(`could not parse a spreadsheet ID from "${ref}"`);
  }

  const gidMatch = /[#?&]gid=(\d+)/.exec(text);
  return { spreadsheetId, gid: gidMatch ? gidMatch[1] : null };
}
