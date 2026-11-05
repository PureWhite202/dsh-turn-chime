"""生成 dsh-turn-chime 用的两个提示音（正弦/谐波合成，无版权素材、非系统音）。

用法：python scripts/make-sounds.py
输出：
  assets/1.wav  结束音，G6→E6→C6→G5 四连音木琴下琶音
  assets/2.wav  提问音，同一套音色的逐音镜像 G5→C6→E6→G6（上行）

两个文件只有音序方向相反，音色、间隔、每个音的时长与响度完全一致。
"""

import math
import os
import wave

import numpy as np

SR = 44100
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets')

# 马林巴音色：(倍频, 振幅, 衰减时间常数)
MARIMBA = [(1.0, 1.0, 0.24), (3.9, 0.33, 0.11), (9.2, 0.07, 0.04)]


def struck(freq, duration, amp=1.0, partials=MARIMBA, click=0.0):
    n = int(SR * duration)
    t = np.arange(n) / SR
    samples = np.zeros(n)
    for ratio, level, tau in partials:
        samples += level * np.exp(-t / tau) * np.sin(2 * math.pi * freq * ratio * t)
    if click > 0:
        rng = np.random.default_rng(int(freq))
        click_len = int(0.004 * SR)
        samples[:click_len] += click * rng.standard_normal(click_len) * np.linspace(1, 0, click_len)
    attack = int(0.003 * SR)
    samples[:attack] *= np.sin(np.linspace(0, math.pi / 2, attack)) ** 2
    release = int(0.05 * SR)
    samples[-release:] *= np.linspace(1, 0, release) ** 2
    return amp * samples


def mix(events, total):
    buf = np.zeros(int(SR * total))
    for start, clip in events:
        at = int(start * SR)
        end = min(at + len(clip), len(buf))
        buf[at:end] += clip[: end - at]
    return buf


def write_wav(path, samples, peak=0.42):
    samples = samples / max(np.max(np.abs(samples)), 1e-9) * peak
    pcm = np.clip(samples, -1, 1)
    with wave.open(path, 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes((pcm * 32767).astype('<i2').tobytes())
    return len(samples) / SR


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    g5, c6, e6, g6 = 783.99, 1046.50, 1318.51, 1567.98

    sounds = {
        # 结束音：四连音下行，收尾感
        '1.wav': mix(
            [
                (0.00, struck(g6, 0.6, 1.0, MARIMBA, click=0.05)),
                (0.075, struck(e6, 0.5, 0.95, MARIMBA, click=0.05)),
                (0.150, struck(c6, 0.45, 0.9, MARIMBA, click=0.05)),
                (0.225, struck(g5, 0.45, 0.9, MARIMBA, click=0.05)),
            ],
            0.95,
        ),
        # 提问音：逐音镜像的上行，像一句「嗯？」
        '2.wav': mix(
            [
                (0.00, struck(g5, 0.45, 0.9, MARIMBA, click=0.05)),
                (0.075, struck(c6, 0.45, 0.9, MARIMBA, click=0.05)),
                (0.150, struck(e6, 0.5, 0.95, MARIMBA, click=0.05)),
                (0.225, struck(g6, 0.6, 1.0, MARIMBA, click=0.05)),
            ],
            0.95,
        ),
    }
    for name, samples in sounds.items():
        seconds = write_wav(os.path.join(OUT_DIR, name), samples)
        print(f'{name}: {seconds:.2f}s')


if __name__ == '__main__':
    main()
