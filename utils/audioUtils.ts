
// Standard decoding for raw PCM data from Gemini Live/TTS API
export function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Decodes the standard PCM buffer from Gemini to an AudioBuffer
export async function decodeAudioData(
  arrayBuffer: ArrayBuffer,
  ctx: AudioContext,
  sampleRate: number = 24000, 
  numChannels: number = 1
): Promise<AudioBuffer> {
    // Convert the ArrayBuffer to Int16Array (PCM data)
    // If the input is already a buffer of bytes, we view it as Int16
    const dataInt16 = new Int16Array(arrayBuffer);
    const frameCount = dataInt16.length / numChannels;
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

    for (let channel = 0; channel < numChannels; channel++) {
        const channelData = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i++) {
            // Convert Int16 to Float32 [-1.0, 1.0]
            channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
        }
    }
    return buffer;
}
