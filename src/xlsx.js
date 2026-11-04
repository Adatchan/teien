/**
 * 小さな Excel（.xlsx）の書き出し。ライブラリを使わず、Workers の中で作る。
 *
 * .xlsx は XML のファイルをいくつか ZIP にまとめたもの。ここでは
 *   - 文字はセルの中に直接書く（inlineStr。共有文字列の表は作らない）
 *   - ZIP は圧縮しない（stored）。大きくならないので十分
 *   - 見た目（フォント・塗り・罫線・金額の書式）は STYLES の決まった番号から選ぶ
 * という最小の形にしている。
 *
 * buildXlsx({ sheets: [sheet, ...] }) → Uint8Array
 *   sheet = {
 *     name: 'シート名',
 *     cols: [列の幅, ...],
 *     rows: [[セル, ...], ...],        // セル = null | 文字列 | 数 | { v, s, f }（v: 値、s: STYLES の名前、f: 数式）
 *     heights: { 行番号(1〜): 高さ },
 *     merges: ['A1:H1', ...],
 *     freeze: 'A5',                     // この左上で固定（見出しまでをスクロールで残す）
 *     autoFilter: 'A4:I10',
 *     printTitles: '$4:$4',             // 印刷のときページごとに繰り返す行
 *     landscape: true,
 *   }
 */

// ---- 見た目（styles.xml の cellXfs の並びと同じ順番） ----
const FONT = 'BIZ UDPゴシック';   // Windows・Mac の Office に入っていて読みやすいフォント
const C = { line: 'FFD5CABF', head: 'FF8B5A3C', headText: 'FFFFFFFF', sub: 'FF6B6B6B', red: 'FFB3261E', redBg: 'FFFDECEA', yellow: 'FF7A5A00', yellowBg: 'FFFFF4CC', green: 'FF2E7D32', greenBg: 'FFE8F5E9', total: 'FFF3ECE4', band: 'FFFBF8F4' };
export const STYLES = ['default', 'title', 'sub', 'head', 'text', 'num', 'yen', 'stNo', 'stPart', 'stDone', 'totalLabel', 'totalNum', 'totalYen', 'center', 'textBand', 'numBand', 'yenBand', 'centerBand', 'sign', 'wrap', 'wrapBand'];
const S = Object.fromEntries(STYLES.map((n, i) => [n, i]));

function stylesXml() {
  const fonts = [
    `<font><sz val="11"/><name val="${FONT}"/><family val="3"/><charset val="128"/></font>`,                                   // 0 ふつう
    `<font><b/><sz val="15"/><name val="${FONT}"/><family val="3"/><charset val="128"/></font>`,                              // 1 題名
    `<font><sz val="10"/><color rgb="${C.sub}"/><name val="${FONT}"/><family val="3"/><charset val="128"/></font>`,           // 2 補足
    `<font><b/><sz val="11"/><color rgb="${C.headText}"/><name val="${FONT}"/><family val="3"/><charset val="128"/></font>`,  // 3 見出し
    `<font><b/><sz val="11"/><name val="${FONT}"/><family val="3"/><charset val="128"/></font>`,                              // 4 太字
    `<font><b/><sz val="11"/><color rgb="${C.red}"/><name val="${FONT}"/><family val="3"/><charset val="128"/></font>`,       // 5 未回収
    `<font><b/><sz val="11"/><color rgb="${C.yellow}"/><name val="${FONT}"/><family val="3"/><charset val="128"/></font>`,    // 6 一部
    `<font><b/><sz val="11"/><color rgb="${C.green}"/><name val="${FONT}"/><family val="3"/><charset val="128"/></font>`,     // 7 回収済み
  ];
  const fill = (rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>',
    fill(C.head), fill(C.redBg), fill(C.yellowBg), fill(C.greenBg), fill(C.total), fill(C.band)];   // 2 見出し 3 赤 4 黄 5 緑 6 合計 7 縞
  const side = (k, style = 'thin', rgb = C.line) => `<${k} style="${style}"><color rgb="${rgb}"/></${k}>`;
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>',
    `<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`,                              // 1 細い線
    `<border>${side('left')}${side('right')}${side('top', 'medium', 'FF3A2E26')}${side('bottom', 'medium', 'FF3A2E26')}<diagonal/></border>`];   // 2 合計
  // [font, fill, border, numFmt, 横, 縦, 折り返し]
  const xf = (font, fill, border, fmt, h, v = 'center', wrap = false) =>
    `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"${font ? ' applyFont="1"' : ''}${fill ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}${fmt ? ' applyNumberFormat="1"' : ''} applyAlignment="1"><alignment${h ? ` horizontal="${h}"` : border ? ' horizontal="left" indent="1"' : ''} vertical="${v}"${wrap ? ' wrapText="1"' : ''}/></xf>`;
  const cellXfs = [
    xf(0, 0, 0, 0),              // default
    xf(1, 0, 0, 0),              // title
    xf(2, 0, 0, 0),              // sub
    xf(3, 2, 1, 0, 'center', 'center', true),   // head
    xf(0, 0, 1, 0),              // text
    xf(0, 0, 1, 3, 'right'),     // num（#,##0）
    xf(0, 0, 1, 164, 'right'),   // yen
    xf(5, 3, 1, 0, 'center'),    // stNo 未回収
    xf(6, 4, 1, 0, 'center'),    // stPart 一部
    xf(7, 5, 1, 0, 'center'),    // stDone 回収済み
    xf(4, 6, 2, 0, 'center'),    // totalLabel
    xf(4, 6, 2, 3, 'right'),     // totalNum
    xf(4, 6, 2, 164, 'right'),   // totalYen
    xf(0, 0, 1, 0, 'center'),    // center
    xf(0, 7, 1, 0),              // textBand
    xf(0, 7, 1, 3, 'right'),     // numBand
    xf(0, 7, 1, 164, 'right'),   // yenBand
    xf(0, 7, 1, 0, 'center'),    // centerBand
    xf(0, 0, 1, 0),              // sign（受領サインの空欄）
    xf(0, 0, 1, 0, null, 'center', true),       // wrap
    xf(0, 7, 1, 0, null, 'center', true),       // wrapBand
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0"/></numFmts>
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${cellXfs.length}">${cellXfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
/** 列番号（0〜）→ A, B, …, Z, AA … */
export const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

function sheetXml(sh) {
  const rowsXml = sh.rows.map((row, r) => {
    const cells = (row || []).map((c, ci) => {
      if (c == null || c === '') return '';
      const cell = typeof c === 'object' ? c : { v: c };
      const ref = colName(ci) + (r + 1);
      const s = cell.s != null ? ` s="${S[cell.s] ?? 0}"` : '';
      if (cell.f) return `<c r="${ref}"${s}><f>${esc(cell.f)}</f>${cell.v != null ? `<v>${Number(cell.v) || 0}</v>` : ''}</c>`;
      if (cell.v == null || cell.v === '') return `<c r="${ref}"${s}/>`;
      if (typeof cell.v === 'number') return `<c r="${ref}"${s}><v>${cell.v}</v></c>`;
      return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
    }).join('');
    const ht = sh.heights && sh.heights[r + 1] ? ` ht="${sh.heights[r + 1]}" customHeight="1"` : '';
    return `<row r="${r + 1}"${ht}>${cells}</row>`;
  }).join('');
  const [fc, fr] = sh.freeze ? [sh.freeze.match(/[A-Z]+/)[0], Number(sh.freeze.match(/\d+/)[0])] : [];
  const pane = sh.freeze ? `<pane ySplit="${fr - 1}"${fc !== 'A' ? '' : ''} topLeftCell="${sh.freeze}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="${sh.freeze}" sqref="${sh.freeze}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" zoomScale="100" showGridLines="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="20" customHeight="1"/>
<cols>${(sh.cols || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rowsXml}</sheetData>
${sh.autoFilter ? `<autoFilter ref="${sh.autoFilter}"/>` : ''}
${sh.merges && sh.merges.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}
<printOptions horizontalCentered="1"/>
<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="${sh.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;C&amp;P / &amp;N ページ</oddFooter></headerFooter>
</worksheet>`;
}

function workbookXml(sheets) {
  const names = [];
  sheets.forEach((sh, i) => {
    const q = `'${sh.name.replace(/'/g, "''")}'`;
    if (sh.autoFilter) {
      const [a, b] = sh.autoFilter.split(':');
      const abs = (ref) => ref.replace(/([A-Z]+)(\d+)/, '$$$1$$$2');
      names.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(q)}!${abs(a)}:${abs(b)}</definedName>`);
    }
    if (sh.printTitles) names.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${esc(q)}!${sh.printTitles}</definedName>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView activeTab="0"/></bookViews>
<sheets>${sheets.map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
${names.length ? `<definedNames>${names.join('')}</definedNames>` : ''}
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`;
}

export function buildXlsx({ sheets, title = '', creator = '' }) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`],
    ['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title)}</dc:title><dc:creator>${esc(creator)}</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`],
    ['docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${esc(creator)}</Application></Properties>`],
    ['xl/workbook.xml', workbookXml(sheets)],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ['xl/styles.xml', stylesXml()],
    ...sheets.map((sh, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sh)]),
  ];
  return zipStored(files.map(([name, text]) => [name, new TextEncoder().encode(text)]));
}

// ---- ZIP（圧縮なし） ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStored(entries) {
  const chunks = [], central = [];
  let offset = 0;
  const dosTime = 0, dosDate = (2026 - 1980) << 9 | 1 << 5 | 1;   // 日時は固定（中身に関係しない）
  for (const [name, data] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true);
    cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true); cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}
