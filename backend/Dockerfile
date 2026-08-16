FROM maven:3.9.9-eclipse-temurin-17 AS build

WORKDIR /workspace
COPY pom.xml ./
COPY src ./src
RUN mvn --batch-mode --no-transfer-progress package -DskipTests

FROM eclipse-temurin:17-jre-jammy

RUN groupadd --system app && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app
WORKDIR /app

COPY --from=build --chown=app:app /workspace/target/tournament-api-0.1.0.jar /app/app.jar

USER app
EXPOSE 10000

# Every ceiling below is bounded so their SUM fits the container, which is the property the previous
# settings lacked: heap 360 MB + metaspace 128 MB + the default 240 MB reserved code cache + 2 MB per
# thread stack allowed the JVM to commit ~730 MB inside a 512 MB Starter instance. The kernel then
# killed the container rather than the JVM collecting — measured RSS reached 525 MB and Render
# restarted the service mid-load-test, which is what produced the 502 storms and the "heap never
# recovers" behaviour.
#
# Sized from 17 stage measurements on Render (load-testing/results/*): non-heap used 139–155 MB,
# direct buffers under 0.5 MB, 30–70 live threads, and RSS − heapUsed consistently 257–300 MB.
#
#   heap ceiling  42% of 512 = 216 MB   (was 360 MB; observed live set 142–155 MB)
#   metaspace     96 MB                 (measured 86 MB with publication enabled — plan §B.1)
#   code cache    64 MB                 (default reserves 240 MB)
#   direct        32 MB                 (measured under 0.5 MB; default is unbounded)
#   ------------------------------------------------------------------
#   bounded sum   408 MB, leaving ~100 MB for thread stacks and JVM native
#
# Thread stack size is deliberately left at its default. Stacks are committed lazily — a thread
# touches a fraction of its reservation — so -Xss trades a real StackOverflowError risk in deep
# framework frames for a small RSS saving. The ceilings above are the ones that actually commit.
#
# The percentage adapts if the instance is resized for an event: 42% of a 2 GB Standard is 880 MB.
# This bounds the JVM to its container; it is not a fix for the RSS creep observed at idle
# (407 MB → 497 MB over 32 h with zero SSE streams), which still needs its own investigation.
ENV JAVA_TOOL_OPTIONS="-XX:InitialRAMPercentage=20 -XX:MaxRAMPercentage=42 -XX:MaxMetaspaceSize=96m -XX:ReservedCodeCacheSize=64m -XX:MaxDirectMemorySize=32m -XX:+UseSerialGC -Djava.security.egd=file:/dev/urandom"

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
