# Build from the kitchen repository: docker build -f keycloak/Dockerfile keycloak
ARG KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.8.1
FROM ${KEYCLOAK_IMAGE}
COPY --chown=keycloak:keycloak themes/blitzpay-kitchen /opt/keycloak/themes/blitzpay-kitchen
