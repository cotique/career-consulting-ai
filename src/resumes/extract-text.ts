import { BadRequestException } from '@nestjs/common';

/**
 * Turns an uploaded file into plain text for the extraction prompt.
 *
 * Needed because the LLM layer's contract is text: untrusted content is
 * rendered into delimited data blocks, and that convention is what keeps a
 * resume from being read as instructions. Passing a PDF through as a native
 * document would bypass that rendering path and change the provider interface,
 * so the bytes are flattened here instead.
 *
 * The cost of that choice is real and worth stating: a text extractor reads a
 * two-column resume in the order the bytes happen to sit, not the order a human
 * reads them, so a heavily designed CV can come out interleaved. Claude accepts
 * PDFs natively and handles layout far better. Left as it is, with the
 * trigger being exactly what you will notice first — extraction quality on a
 * real, designed resume.
 */
export const ACCEPTED_MIME_TYPES = new Map<string, string>([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['text/plain', 'txt'],
]);

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function extensionFor(mimeType: string): string {
  const ext = ACCEPTED_MIME_TYPES.get(mimeType);
  if (!ext) {
    throw new BadRequestException(
      `Unsupported file type "${mimeType}". Upload a PDF, a .docx, or plain text.`,
    );
  }
  return ext;
}

export async function extractText(content: Buffer, mimeType: string): Promise<string> {
  const kind = extensionFor(mimeType);

  let text: string;
  if (kind === 'txt') {
    text = content.toString('utf8');
  } else if (kind === 'pdf') {
    // pdf-parse's bundled pdfjs-dist instantiates a DOMMatrix at module load
    // time (src/display/canvas.js, unconditionally, even for text-only
    // extraction) and only polyfills it itself on Node >=20.16/22.3 — this
    // repo's pinned Node 20 can be older than that. Polyfilling here, once,
    // before the module ever loads, is what stands in for a DOM on any Node
    // 20.x. Path2D/ImageData are referenced only inside pdf.js's actual
    // rendering paths, which text-only extraction never reaches, so they
    // need no polyfill.
    const globalWithDOMMatrix = globalThis as { DOMMatrix?: unknown };
    if (typeof globalWithDOMMatrix.DOMMatrix === 'undefined') {
      const { default: CSSMatrix } = await import('@thednp/dommatrix');
      globalWithDOMMatrix.DOMMatrix = CSSMatrix;
    }

    // Loaded lazily: these parsers are only needed when a file of that type
    // actually arrives, and both are heavier than the rest of the app.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: content });
    try {
      text = (await parser.getText()).text;
    } finally {
      // The parser holds a pdf.js document open; without this, uploads leak a
      // worker and its buffers for the life of the process.
      await parser.destroy();
    }
  } else {
    const mammoth = await import('mammoth');
    text = (await mammoth.extractRawText({ buffer: content })).value;
  }

  const trimmed = text.replace(/\r\n/g, '\n').trim();
  if (!trimmed) {
    // A PDF of scanned images extracts to nothing. Saying so beats sending an
    // empty document to the model and reporting whatever it invents.
    throw new BadRequestException(
      'No text could be read from that file. If it is a scan or an image-only PDF, it needs OCR first — that is not supported yet.',
    );
  }
  return trimmed;
}
