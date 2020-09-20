/* eslint-disable no-labels */
// states
const VALUE_STATE = 0x10
const CLOSE_OBJECT_STATE = 0x30
const OPEN_ARRAY_STATE = 0x40
const CLOSE_ARRAY_STATE = 0x50
const OPEN_KEY_STATE = 0x60
const CLOSE_KEY_STATE = 0x70
const OBJECT_KEY_STATE = 0x90

const STRING_VALUE_STATE = 0x21
const KEYWORD_VALUE_STATE = 0x31
const NUMBER_VALUE_STATE = 0x41

const NUMBER_FRACTION_SUBSTATE = 0x42
const NUMBER_EXPONENT_1_SUBSTATE = 0x43
const NUMBER_EXPONENT_2_SUBSTATE = 0x44


interface KissJonsReaderKeyword {
    chars: number[],
    value: boolean|null,
    raw: string,
}

// @ts-ignore
const keywords = new Map<number, KissJonsReaderKeyword>(([['true', true], ['false', false], ['null', null]] as [string,boolean|null][])
    .map(kvp => [kvp[0].charCodeAt(0), { chars: kvp[0].split('').map(v => v.charCodeAt(0)), value: kvp[1], raw: kvp[0] }])
)

interface KissJsonReaderResolver {
    emitArrayClose(): void,
    emitObjectClose(): void,
    emitKeyValue(buffer: Buffer, start: number, end: number, escaped: boolean, next: undefined|KissJsonReaderState) : void
    emitStringValue(buffer: Buffer, start: number, end: number, escaped: boolean, next: undefined|KissJsonReaderState) : void
    emitNumericValue(buffer: Buffer, start: number,end: number, length: number, next: undefined|KissJsonReaderState) : void,
    emitTokenValue(keyword: string, value: null|boolean):void,
    emitObjectOpen():void
    emitArrayOpen():void
    emitError(message: string):void,
    reset():void
}

interface KissJsonReaderState {
    chunk: Buffer,
    start: number,
    end: number,
    length: number,
    totalLength: number,
    next: KissJsonReaderState|undefined,
    meta1: any,
    meta2: any
}

export function JsonReaderFactory (resolver:KissJsonReaderResolver) {
    let state: number|undefined
    let buffer: undefined|KissJsonReaderState
    let stack: number[] = []

    reset()

    return {
        parser: machine,
        reset
    }
    function reset () {
        state = VALUE_STATE
        buffer = undefined
        if (stack.length) stack = []
        resolver.reset()
    }

    function machine (chunk: Buffer) {
        const l = chunk.length

        CHUNK_LOOP: for (let i = 0; i < l; i++) {
            const c = chunk[i]
            // skip whitespace if state is not a value capture state
            // @ts-ignore
            if ((c === 32 || c === 10 || c === 13 || c === 7) && (state & 0x0f) === 0) continue

            switch (state) {
                case OPEN_KEY_STATE:
                    if (c === 34) {
                        stack.push(CLOSE_KEY_STATE)
                        state = STRING_VALUE_STATE
                        break
                    }
                    return resolver.emitError('expected start of string')
                case CLOSE_KEY_STATE:
                    if (c === 58 /*:*/) {
                        stack.push(CLOSE_OBJECT_STATE)
                        state = VALUE_STATE
                        continue
                    }
                    return resolver.emitError('Bad object')
                case OBJECT_KEY_STATE:
                    if (c === 34 /* double quote */) {
                        stack.push(CLOSE_KEY_STATE)
                        state = STRING_VALUE_STATE
                        continue
                    } else if (c === 125 /* } */) {
                        resolver.emitObjectClose()
                        state = stack.pop()
                        continue
                    }
                    return resolver.emitError('expected error')
                case CLOSE_OBJECT_STATE:
                    if (c === 44 /* , */) {
                        state = OPEN_KEY_STATE
                        continue
                    } else if (c === 125 /* } */) {
                        resolver.emitObjectClose()
                        state = stack.pop()
                        continue
                    }
                    return resolver.emitError('expected error')
                case CLOSE_ARRAY_STATE:
                    if (c === 44 /* , */) {
                        stack.push(CLOSE_ARRAY_STATE)
                        state = VALUE_STATE
                        continue
                    } else if (c === 93 /* ] */) {
                        resolver.emitArrayClose()
                        state = stack.pop()
                        continue
                    }
                    return resolver.emitError('Bad array')
                case OPEN_ARRAY_STATE: // after an array there always a value
                    if (c === 93 /* ] */) {
                        resolver.emitArrayClose()
                        state = stack.pop()
                        continue
                    }
                    stack.push(CLOSE_ARRAY_STATE)
                    state = VALUE_STATE
                // IMPORTANT!!! FALLTHROUGH to VALUE state
                // eslint-disable-next-line no-fallthrough
                case VALUE_STATE:
                    if (c === 34 /* " */) {
                        state = STRING_VALUE_STATE
                        break
                    } else if (c === 45 || (c >= 48 && c <= 57) /* -, 0-9 */) {
                        state = NUMBER_VALUE_STATE
                        break
                    } else if (c === 116 || c === 102 || c === 110 /* t/f/n */) {
                        state = KEYWORD_VALUE_STATE
                        break
                    } else if (c === 123 /* { */) {
                        resolver.emitObjectOpen()
                        state = OBJECT_KEY_STATE
                        continue
                    } else if (c === 91 /* [ */) {
                        resolver.emitArrayOpen()
                        state = OPEN_ARRAY_STATE
                        continue
                    }
                    return resolver.emitError('Bad value')
                case KEYWORD_VALUE_STATE:
                case NUMBER_VALUE_STATE:
                case STRING_VALUE_STATE:
                    break
                default:
                    return resolver.emitError('Unknown state: ' + state)
            }

            switch (state) {
                case KEYWORD_VALUE_STATE: {
                    const start = i
                    let valueState = buffer ? buffer.meta1 as number : 0
                    const keyword = buffer ? buffer.meta2 as KissJonsReaderKeyword : keywords.get(c)
                    if (!keyword) return resolver.emitError('Bad value')
                    const k = keyword.chars

                    for (; i < l; i++) {
                        if (k[valueState++] !== chunk[i]) {
                            return resolver.emitError('keyword invalid')
                        }
                        if (valueState < k.length) {
                            continue
                        }
                        resolver.emitTokenValue(keyword.raw, keyword.value)
                        buffer = undefined
                        state = stack.pop()
                        continue CHUNK_LOOP
                    }
                    // buffer = { chunk, start, end: l, length: l - start, totalLength: (buffer ? buffer.totalLength : 0) + (l - start), next: buffer, valueState, keyword }
                    return setState(chunk, start, i, valueState, 0)
                }
                case NUMBER_VALUE_STATE: {
                    const start = buffer ? 0 : i - 1
                    let valueState = buffer ? buffer.meta1 as number : NUMBER_VALUE_STATE
                    for (; i < l; i++) {
                        const v = chunk[i]

                        switch (valueState) {
                            case NUMBER_VALUE_STATE:
                                if (v >= 48 && v <= 57 /* 0 */) {
                                    continue
                                } else if (v === 46) {
                                    valueState = NUMBER_FRACTION_SUBSTATE
                                    continue
                                } else if (v === 101 || v === 69 /* e or E */) {
                                    valueState = NUMBER_EXPONENT_1_SUBSTATE
                                    continue
                                }
                                break
                            case NUMBER_FRACTION_SUBSTATE:
                                if (v >= 48 && v <= 57 /* 0 */) {
                                    continue
                                } else if (v === 101 || v === 69 /* e or E */) {
                                    valueState = NUMBER_EXPONENT_1_SUBSTATE
                                    continue
                                }
                                break
                            case NUMBER_EXPONENT_1_SUBSTATE:
                                if ((v >= 48 && v <= 57) || v === 43 || v === 45 /* 0-9 or +/- */) {
                                    valueState = NUMBER_EXPONENT_2_SUBSTATE
                                    continue
                                }
                                break
                            case NUMBER_EXPONENT_2_SUBSTATE:
                                if (v >= 48 && v <= 57 /* 0 */) {
                                    continue
                                }
                                break
                        }
                        resolver.emitNumericValue(chunk, start, i, i - start, buffer)
                        buffer = undefined
                        state = stack.pop()
                        i-- // Rewind
                        continue CHUNK_LOOP
                    }
                    // buffer = { chunk, start, end: l, length: l - start, totalLength: (buffer ? buffer.totalLength : 0) + (l - start), next: buffer, valueState }
                    return setState(chunk, start, i, valueState, 0)
                }
                case STRING_VALUE_STATE: {
                    if (!buffer) i++ // Skip opening quote
                    const start = i
                    if (buffer && buffer.meta1) i++ // Skip escaped character
                    let escaped = (buffer && buffer.meta2 as boolean) || false
                    for (; i < l; i++) {
                        const s = chunk[i]
                        if (s === 34) {
                            state = stack.pop()
                            if (state === CLOSE_KEY_STATE) {
                                resolver.emitKeyValue(chunk, start, i, escaped , buffer)
                            } else {
                                resolver.emitStringValue(chunk, start, i, escaped, buffer)
                            }
                            buffer = undefined
                            continue CHUNK_LOOP
                        } else if (s === 92 /* slash */) {
                            // If we have a slash, then we need to escape the next character.
                            // If we are at the end of the input, then we need to set slash indicator to true
                            escaped = true
                            if (++i === l)
                                return setState(chunk, start, i, true, escaped)
                        }
                    }
                    // buffer = { chunk, start, end: l, length: l - start, totalLength: (buffer ? buffer.totalLength : 0) + (l - start), next: buffer, valueState: escaped, keyword: escapes }
                    return setState(chunk, start, i, false, escaped)
                }
                default:
                    return resolver.emitError('Unknown state: ' + state)
            }
        }
    }
    function setState(chunk: Buffer, start: number, end: number,meta1: any, meta2: any) {
        const length = chunk.length - start
        buffer = {
            chunk,
            start,
            end,
            length,
            totalLength: buffer ? length + buffer.totalLength : length,
            next: buffer,
            meta1: meta1,
            meta2: meta2
        }
    }
}


