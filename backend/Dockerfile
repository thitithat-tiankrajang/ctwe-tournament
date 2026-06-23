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

ENV JAVA_TOOL_OPTIONS="-XX:InitialRAMPercentage=20 -XX:MaxRAMPercentage=70 -XX:MaxMetaspaceSize=128m -XX:+UseSerialGC -Djava.security.egd=file:/dev/urandom"

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
