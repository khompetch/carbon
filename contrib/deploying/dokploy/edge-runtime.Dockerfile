# Edge functions baked into the image instead of bind-mounted from the
# checkout. Bind mounts are only evaluated when a container is *created* — a
# container created while the Dokploy checkout was still syncing kept serving
# an empty, stale view of the functions directory forever ("worker boot
# error: ... could not find an appropriate entrypoint"). Building the code in
# makes every deploy atomic: the image either has the functions or the build
# fails. Build context is the repo root.
FROM supabase/edge-runtime:v1.74.0

# No run.sh shim here: the root .dockerignore excludes contrib/ from the build
# context (the shim only existed so bind-mount-era CMD arrays could be reused),
# and a Dockerfile can set the entrypoint directly.
COPY packages/database/supabase/functions /home/deno/functions
COPY packages/database/src /home/src
COPY packages/dev/docker/edge-main /home/deno/main

ENTRYPOINT ["edge-runtime"]
CMD ["start", "--main-service", "/home/deno/main"]
