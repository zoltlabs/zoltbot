FROM ubuntu:24.04
COPY templates/sandbox/install.sh /tmp/zoltbot-install.sh
RUN /bin/sh /tmp/zoltbot-install.sh runtime
WORKDIR /opt/zoltbot
COPY . .
RUN /bin/sh /tmp/zoltbot-install.sh worker
USER user
ENV HOME=/home/user SHELL=/bin/bash PLAYWRIGHT_BROWSERS_PATH=/opt/chromium
WORKDIR /home/user
ENTRYPOINT ["/usr/local/bin/zolt-worker"]
