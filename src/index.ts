/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @oncall react_native
 */


// Use import.meta.require so it isn't included in the bundle.
const hermesc = import.meta.require('./emhermesc.js')({
  noInitialRun: true,
  noExitRuntime: true,
  // Do not call console methods
  print: () => {},
  printErr: () => {},
});

export type Options = {
  sourceURL: string,
  sourceMap?: string,
};

export type HermesCompilerResult = Readonly<{
  bytecode: Buffer,
}>;

const compileToBytecode = hermesc.cwrap('hermesCompileToBytecode', 'number', [
  'number',
  'number',
  'string',
  'number',
  'number',
]);
const getError = hermesc.cwrap('hermesCompileResult_getError', 'string', [
  'number',
]);
const getBytecodeAddr = hermesc.cwrap(
  'hermesCompileResult_getBytecodeAddr',
  'number',
  ['number'],
);
const getBytecodeSize = hermesc.cwrap(
  'hermesCompileResult_getBytecodeSize',
  'number',
  ['number'],
);
const free = hermesc.cwrap('hermesCompileResult_free', 'void', ['number']);
const props = (JSON.parse(
  hermesc.ccall('hermesGetProperties', 'string', [], []),
) as {
  BYTECODE_ALIGNMENT: number,
  HEADER_SIZE: number,
  LENGTH_OFFSET: number,
  MAGIC: Array<number>,
  VERSION: number,
});

function strdup(str: string) {
  var copy = Buffer.from(str, 'utf8');
  var size = copy.length + 1;
  var address = hermesc._malloc(size);
  if (!address) {
    throw new Error('hermesc string allocation error');
  }
  hermesc.HEAP8.set(copy, address);
  hermesc.HEAP8[address + copy.length] = 0;
  return {ptr: address, size};
}

export const align = (offset: number): number =>
  /* eslint-disable-next-line no-bitwise */
  (offset + props.BYTECODE_ALIGNMENT - 1) & ~(props.BYTECODE_ALIGNMENT - 1);


export const compile = function (
  source: string | Buffer,
  {sourceURL, sourceMap}: Options,
): HermesCompilerResult {
  const buffer =
    typeof source === 'string' ? Buffer.from(source, 'utf8') : source;

  const address = hermesc._malloc(buffer.length + 1);
  if (!address) {
    throw new Error('Hermesc is out of memory.');
  }

  try {
    hermesc.HEAP8.set(buffer, address);
    hermesc.HEAP8[address + buffer.length] = 0;

    // Strings are passed on the stack by default. Explicitly pass the source map
    // on the heap to avoid problems with large ones.
    const sourceMapNotNull = sourceMap ?? '';
    const mapOnHeap = strdup(sourceMapNotNull);
    let result;
    try {
      result = compileToBytecode(
        address,
        buffer.length + 1,
        sourceURL,
        mapOnHeap.ptr,
        mapOnHeap.size,
      );
    } finally {
      hermesc._free(mapOnHeap.ptr);
    }

    try {
      const error = getError(result);
      if (error) {
        throw new Error(error);
      }

      const bufferFromHBC = Buffer.from(
        hermesc.HEAP8.buffer,
        getBytecodeAddr(result),
        getBytecodeSize(result),
      );
      const bytecode = Buffer.alloc(align(bufferFromHBC.length));
      bufferFromHBC.copy(bytecode, 0);
      return {
        bytecode,
      };
    } finally {
      free(result);
    }
  } finally {
    hermesc._free(address);
  }
};

export const validateBytecodeModule = function (
  bytecode: Buffer,
  offset: number,
): void {
  if ((bytecode.byteOffset + offset) % props.BYTECODE_ALIGNMENT) {
    throw new Error(
      'Bytecode is not aligned to ' + props.BYTECODE_ALIGNMENT + '.',
    );
  }

  const fileLength = bytecode.readUInt32LE(offset + props.LENGTH_OFFSET);
  if (
    bytecode.length - offset < props.HEADER_SIZE ||
    bytecode.length - offset < fileLength
  ) {
    throw new Error('Bytecode buffer is too small.');
  }

  if (
    bytecode.readUInt32LE(offset + 0) !== props.MAGIC[0] ||
    bytecode.readUInt32LE(offset + 4) !== props.MAGIC[1]
  ) {
    throw new Error('Bytecode buffer is missing magic value.');
  }

  const version = bytecode.readUInt32LE(offset + 8);
  if (version !== props.VERSION) {
    throw new Error(
      'Bytecode version is ' +
        version +
        ' but ' +
        props.VERSION +
        ' is required.',
    );
  }
};

export const getFileLength = function (
  bytecode: Buffer,
  offset: number,
): number {
  return bytecode.readUInt32LE(offset + props.LENGTH_OFFSET);
};

export const VERSION = props.VERSION;
