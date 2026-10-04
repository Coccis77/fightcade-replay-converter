# fc2mp4: Fightcade 3rd Strike replay -> MP4, headless (x86-64 only).
# Mount your Fightcade folder at /fightcade (read-only) and an output folder at /videos, writable by
# uid 1000 (create it first, or Docker Engine creates it owned by root):
#   mkdir -p videos && docker run --rm -v /path/to/Fightcade:/fightcade:ro -v "$PWD/videos":/videos ghcr.io/coccis77/fc2mp4 <replay link>
# The build context must contain fc2mp4-linux-x64 (from the release workflow).
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y wine wine32:i386 ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
# ubuntu:24.04 ships a user "ubuntu" with uid 1000; fc2mp4 takes that uid so the MP4s belong to the
# usual first user of a Linux host.
RUN userdel -r ubuntu \
 && groupadd -g 1000 fc2mp4 \
 && useradd -m -u 1000 -g 1000 fc2mp4 \
 && mkdir /videos /fightcade \
 && chown fc2mp4:fc2mp4 /videos
COPY --chmod=755 fc2mp4-linux-x64 /usr/local/bin/fc2mp4
USER fc2mp4
ENV FC2MP4_FIGHTCADE_DIR=/fightcade FC2MP4_OUTPUT_DIR=/videos
# The emulator and the Wine environment live in the image: every container starts converting at once.
# GITHUB_TOKEN (optional BuildKit secret "gh") avoids the API rate limit on shared CI runners; it is not
# stored in the image.
RUN --mount=type=secret,id=gh,env=GITHUB_TOKEN fc2mp4 prepare
WORKDIR /videos
ENTRYPOINT ["/usr/bin/tini", "--", "fc2mp4"]
