import argparse, json, wave, webrtcvad


def read_pcm16(path):
w = wave.open(path, 'rb')
assert w.getsampwidth() == 2 and w.getnchannels() == 1
rate = w.getframerate()
audio = w.readframes(w.getnframes())
return audio, rate


parser = argparse.ArgumentParser()
parser.add_argument('--audio', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()


audio, rate = read_pcm16(args.audio)
vad = webrtcvad.Vad(2)
frame_ms = 30
frame_bytes = int(rate * frame_ms / 1000) * 2


segments = []
start = 0; voiced = False
for i in range(0, len(audio), frame_bytes):
frame = audio[i:i+frame_bytes]
if len(frame) < frame_bytes: break
is_voiced = vad.is_speech(frame, rate)
t = i / 2 / rate
if is_voiced and not voiced:
start = t; voiced = True
if not is_voiced and voiced and t - start > 0.3:
segments.append({"start": start, "end": t})
voiced = False
if voiced:
segments.append({"start": start, "end": len(audio)/2/rate})


with open(args.out, 'w') as f:
json.dump({"keep": segments}, f)
print('Wrote', args.out)
