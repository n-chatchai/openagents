FROM node:20-alpine

WORKDIR /app

ARG NEXT_PUBLIC_API_URL=https://workspace-endpoint.openagents.org
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
# Self-hosted / preview deployments on their own domain (see
# lib/openagents-auth-context.tsx and lib/auth-redirects.ts).
ARG NEXT_PUBLIC_FIRST_PARTY_HOSTNAMES=
ENV NEXT_PUBLIC_FIRST_PARTY_HOSTNAMES=${NEXT_PUBLIC_FIRST_PARTY_HOSTNAMES}
ARG NEXT_PUBLIC_INLINE_LOGIN=
ENV NEXT_PUBLIC_INLINE_LOGIN=${NEXT_PUBLIC_INLINE_LOGIN}
# Behind an authenticating proxy that is the login (lib/door.ts).
ARG NEXT_PUBLIC_DOOR_LOGIN=
ENV NEXT_PUBLIC_DOOR_LOGIN=${NEXT_PUBLIC_DOOR_LOGIN}

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy application code
COPY . .

# Build
RUN npm run build

# Run
EXPOSE 3000
CMD ["npm", "start"]
