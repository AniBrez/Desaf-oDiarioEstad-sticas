import { describe, expect, it } from 'vitest';
import { crc32, fileName, makeZip, slug, toCsv } from '../src/export/files';

describe('CSV', () => {
  it('quotes what needs quoting and nothing else', () => {
    const csv = toCsv({
      name: 't',
      columns: ['Name', 'Value', 'Note'],
      rows: [
        ['Plain', 12, ''],
        ['Comma, inside', 3.5, 'He said "hi"'],
        ['Line\nbreak', null, undefined],
        [' padded ', Number.NaN, true],
        ['Hokkaidō', -4, 'São Paulo'],
      ],
    });
    expect(csv.split('\r\n')).toEqual([
      'Name,Value,Note',
      'Plain,12,',
      '"Comma, inside",3.5,"He said ""hi"""',
      '"Line\nbreak",,',
      '" padded ",,true',
      'Hokkaidō,-4,São Paulo',
      '',
    ]);
  });
});

describe('file names', () => {
  it('are plain ASCII slugs', () => {
    expect(slug('Total score over time')).toBe('total-score-over-time');
    expect(slug('Hokkaidō & Iași: rounds')).toBe('hokkaido-iasi-rounds');
    expect(slug('!!!')).toBe('export');
    expect(fileName(['overview', 'Learning curve (diminishing returns)', 'Alex (demo)'], 'pdf'))
      .toMatch(/^desafio-diario_overview_learning-curve-diminishing-returns_alex-demo_\d{4}-\d{2}-\d{2}\.pdf$/);
  });
});

describe('ZIP', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('writes a well-formed archive with unique UTF-8 names', () => {
    const enc = new TextEncoder();
    const zip = makeZip([
      { name: 'a.csv', data: enc.encode('x,y\r\n1,2\r\n') },
      { name: 'a.csv', data: enc.encode('second') },
      { name: 'São Paulo.csv', data: enc.encode('') },
    ]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // End of central directory record.
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(3);
    // Walk the central directory and read the names back.
    let at = view.getUint32(end + 16, true);
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      expect(view.getUint16(at + 8, true) & 0x0800).toBe(0x0800);
      const len = view.getUint16(at + 28, true);
      names.push(new TextDecoder().decode(zip.subarray(at + 46, at + 46 + len)));
      // The stored data matches its CRC.
      const local = view.getUint32(at + 42, true);
      const size = view.getUint32(local + 18, true);
      const nameLen = view.getUint16(local + 26, true);
      expect(crc32(zip.subarray(local + 30 + nameLen, local + 30 + nameLen + size))).toBe(view.getUint32(at + 16, true));
      at += 46 + len;
    }
    expect(names).toEqual(['a.csv', 'a-2.csv', 'São Paulo.csv']);
  });
});
