'use strict';

// Minimal, dependency-free .docx (OOXML) writer.
//
// We only need headings, paragraphs, bullet lists and tables, so rather than
// pull in a library we emit the handful of XML parts a Word document needs and
// zip them with the system `zip` binary. The output opens cleanly in Word,
// Pages and Google Docs.
//
//   const { Doc } = require('./docx');
//   const d = new Doc();
//   d.title('My report');
//   d.h1('Section'); d.p('Body text'); d.bullet('a point');
//   d.table(['Col A', 'Col B'], [['1', '2'], ['3', '4']]);
//   d.save('/path/to/report.docx');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A run of text. `opts`: { bold, italic, color (hex, no #), size (half-points) }
function run(text, opts = {}) {
  const rpr = [];
  if (opts.bold) rpr.push('<w:b/>');
  if (opts.italic) rpr.push('<w:i/>');
  if (opts.color) rpr.push(`<w:color w:val="${opts.color}"/>`);
  if (opts.size) rpr.push(`<w:sz w:val="${opts.size}"/>`);
  const rprXml = rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : '';
  // split on newlines -> <w:br/>
  const parts = String(text == null ? '' : text).split('\n');
  const body = parts
    .map((p, i) => (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${esc(p)}</w:t>`)
    .join('');
  return `<w:r>${rprXml}${body}</w:r>`;
}

class Doc {
  constructor() {
    this.body = [];
  }

  _p(inner, { style, align, spacingAfter } = {}) {
    const ppr = [];
    if (style) ppr.push(`<w:pStyle w:val="${style}"/>`);
    if (align) ppr.push(`<w:jc w:val="${align}"/>`);
    if (spacingAfter != null) ppr.push(`<w:spacing w:after="${spacingAfter}"/>`);
    const pprXml = ppr.length ? `<w:pPr>${ppr.join('')}</w:pPr>` : '';
    this.body.push(`<w:p>${pprXml}${inner}</w:p>`);
  }

  title(text, sub) {
    this._p(run(text), { style: 'Title' });
    if (sub) this._p(run(sub, { color: '666666', size: 26 }), { style: 'Subtitle' });
  }

  h1(text) { this._p(run(text), { style: 'Heading1' }); }
  h2(text) { this._p(run(text), { style: 'Heading2' }); }
  h3(text) { this._p(run(text), { style: 'Heading3' }); }

  // p('plain') or p([{text,bold,...}, ...]) for mixed runs
  p(content, opts = {}) {
    const runs = Array.isArray(content)
      ? content.map((c) => run(c.text, c)).join('')
      : run(content, opts);
    this._p(runs, opts);
  }

  bullet(content, level = 0) {
    const runs = Array.isArray(content)
      ? content.map((c) => run(c.text, c)).join('')
      : run(content);
    this.body.push(
      `<w:p><w:pPr><w:pStyle w:val="ListBullet"/>` +
        `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr>${runs}</w:p>`
    );
  }

  spacer() { this._p(run('')); }

  pageBreak() {
    this.body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  }

  // headers: string[]; rows: (string | {text, bold, color})[][]
  // opts: { widths: number[] (twips), fontSize: half-points }
  table(headers, rows, opts = {}) {
    const cols = headers.length;
    const totalW = 9360; // letter, 1" margins
    const widths =
      opts.widths && opts.widths.length === cols
        ? opts.widths
        : Array(cols).fill(Math.floor(totalW / cols));
    const sz = opts.fontSize || 18;

    const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');

    const cell = (val, i, { header } = {}) => {
      const o = typeof val === 'object' && val !== null ? val : { text: val };
      const runXml = run(o.text, {
        bold: header || o.bold,
        color: o.color,
        size: sz,
      });
      const shd = header ? '<w:shd w:val="clear" w:fill="1F3864"/>' : '';
      const jc = o.align ? `<w:jc w:val="${o.align}"/>` : '';
      const runColored =
        header && !o.color
          ? run(o.text, { bold: true, color: 'FFFFFF', size: sz })
          : runXml;
      return (
        `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/>${shd}` +
        `<w:tcMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/>` +
        `<w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tcMar></w:tcPr>` +
        `<w:p><w:pPr>${jc}<w:spacing w:after="0"/></w:pPr>${runColored}</w:p></w:tc>`
      );
    };

    const headerRow =
      `<w:tr><w:trPr><w:tblHeader/></w:trPr>` +
      headers.map((h, i) => cell(h, i, { header: true })).join('') +
      `</w:tr>`;

    const bodyRows = rows
      .map(
        (r) =>
          `<w:tr>` +
          Array.from({ length: cols }, (_, i) => cell(r[i] == null ? '' : r[i], i)).join('') +
          `</w:tr>`
      )
      .join('');

    this.body.push(
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>` +
        `<w:tblW w:w="${totalW}" w:type="dxa"/>` +
        `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>` +
        `</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`
    );
    this.spacer();
  }

  _documentXml() {
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${this.body.join('')}` +
      `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
      `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>` +
      `</w:sectPr></w:body></w:document>`
    );
  }

  save(outPath) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'));
    const write = (rel, content) => {
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };

    write(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
        `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
        `</Types>`
    );
    write(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`
    );
    write(
      'word/_rels/document.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
        `</Relationships>`
    );
    write('word/styles.xml', STYLES_XML);
    write('word/numbering.xml', NUMBERING_XML);
    write('word/document.xml', this._documentXml());

    const outAbs = path.resolve(outPath);
    if (fs.existsSync(outAbs)) fs.unlinkSync(outAbs);
    const res = spawnSync(
      'zip',
      ['-X', '-r', '-q', outAbs, '[Content_Types].xml', '_rels', 'word'],
      { cwd: tmp }
    );
    fs.rmSync(tmp, { recursive: true, force: true });
    if (res.status !== 0) {
      throw new Error(
        `zip failed (status ${res.status}): ${res.stderr || res.error || ''}`
      );
    }
    return outAbs;
  }
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:docDefaults><w:rPrDefault><w:rPr>` +
  `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/>` +
  `</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="120"/></w:pPr>` +
  `<w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="52"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:pPr><w:spacing w:after="240"/></w:pPr>` +
  `<w:rPr><w:color w:val="666666"/><w:sz w:val="26"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
  `<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>` +
  `<w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="34"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
  `<w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>` +
  `<w:rPr><w:b/><w:color w:val="2E5395"/><w:sz w:val="28"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
  `<w:pPr><w:keepNext/><w:spacing w:before="220" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>` +
  `<w:rPr><w:b/><w:color w:val="404040"/><w:sz w:val="24"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/>` +
  `<w:pPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="360"/></w:pPr></w:style>` +
  `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr>` +
  `<w:tblBorders>` +
  `<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/>` +
  `<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/>` +
  `<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>` +
  `</w:tblBorders></w:tblPr></w:style>` +
  `</w:styles>`;

const NUMBERING_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:abstractNum w:abstractNumId="0">` +
  `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/>` +
  `<w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl>` +
  `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#9702;"/><w:lvlJc w:val="left"/>` +
  `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>` +
  `</w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
  `</w:numbering>`;

module.exports = { Doc, esc };
