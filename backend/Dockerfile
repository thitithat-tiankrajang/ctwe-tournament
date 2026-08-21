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

# Every ceiling below is bounded so their SUM fits the container, which is the property the original
# settings lacked: heap 360 MB + metaspace 128 MB + the default 240 MB reserved code cache + 2 MB per
# thread stack allowed the JVM to commit ~730 MB inside a 512 MB Starter instance, and the kernel
# killed the container rather than the JVM collecting.
#
# Metaspace was first set to 96 MB from a boot-time reading (85.9 MB, snapshot plan §B.1: exploded
# classpath, no traffic). That reading is a FLOOR, not a steady state — Spring MVC, Tomcat, Jackson,
# Security and Hibernate load classes lazily as request paths are first exercised, and every lambda
# call site spins a hidden class on first linkage. Under load the app actually needs ~100-105 MB:
# with the old 128 MB cap, non-heap used settled at 153-155 MB (load-testing/results/2026-08-15*,
# 2026-08-16T20*); with the 96 MB cap it pinned flat at 139-140 MB (2026-08-16T22:51 onward), i.e.
# metaspace was running full and collecting continuously to stay under its own ceiling.
#
# It then went over. The Excel export (POI SXSSF + XMLBeans) is the largest single lazy class-load in
# the process and pushed a metaspace that had no headroom past its cap. A Metaspace OOM is thrown per
# thread and does NOT kill the JVM: every http-nio worker died on class loading (even linking a
# lambda inside MediaType.checkParameters) while the container stayed "up", so Render never restarted
# it. That is the zombie state the deploy log showed.
#
#   heap ceiling  36% of 512 = 184 MB   (heapUsed peaked 158 MB at the tested 400-stream ceiling)
#   metaspace     160 MB                (~100-105 MB steady + room for the POI/XMLBeans export)
#   code cache    64 MB                 (default reserves 240 MB)
#   direct        32 MB                 (measured under 0.5 MB; default is unbounded)
#   ------------------------------------------------------------------
#   bounded sum   440 MB, leaving ~72 MB for thread stacks and JVM native
#
# The margin is thinner than before: the 408 MB bound measured RSS 425 MB at 400 streams, so this one
# lands near 455 MB in a 512 MB box. Heap headroom is what paid for metaspace, and 184 MB against a
# 158 MB peak means SerialGC will collect harder at event scale. A 512 MB instance is now the binding
# constraint on this app, not a comfortable fit — size up for event days.
#
# ExitOnOutOfMemoryError turns any future breach back into a restart Render can act on, instead of a
# process that answers health checks while failing every request.
#
# Thread stack size is deliberately left at its default. Stacks are committed lazily — a thread
# touches a fraction of its reservation — so -Xss trades a real StackOverflowError risk in deep
# framework frames for a small RSS saving. The ceilings above are the ones that actually commit.
#
# The percentage adapts if the instance is resized for an event: 36% of a 2 GB Standard is 737 MB.
# This bounds the JVM to its container; it is not a fix for the RSS creep observed at idle
# (407 MB -> 497 MB over 32 h with zero SSE streams), which still needs its own investigation.
ENV JAVA_TOOL_OPTIONS="-XX:InitialRAMPercentage=20 -XX:MaxRAMPercentage=36 -XX:MaxMetaspaceSize=160m -XX:ReservedCodeCacheSize=64m -XX:MaxDirectMemorySize=32m -XX:+ExitOnOutOfMemoryError -XX:+UseSerialGC -Djava.security.egd=file:/dev/urandom"

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
