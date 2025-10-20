import argparse
from faster_whisper import WhisperModel


parser = argparse.ArgumentParser()
parser.add_argument('--audio', required=True)
parser.add_argument('--srt', required=True)
args = parser.parse_args()


model = WhisperModel("base", device="cpu")
segments, info = model.transcribe(args.audio)


# very simple SRT writer
with open(args.srt, 'w') as f:
idx = 1
for s in segments:
f.write(f"{idx}\n")
f.write(f"{s.start:.2f} --> {s.end:.2f}\n")
f.write((s.text or '').strip() + "\n\n")
idx += 1
print('Wrote', args.srt)
