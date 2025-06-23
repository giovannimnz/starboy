starboy/
├── package.json         # Script dev com concurrently
├── backend/
│   └── server/
│       └── api.js       # API Fastify
└── frontend/
    ├── package.json     # Scripts Next.js
    ├── .env.local       # URL da API
    └── src/
        ├── components/
        │   └── Dashboard.jsx
        └── hooks/
            └── useApi.js

starboy/
├── .git/
├── backend/                <-- Código-fonte do seu backend
│   ├── core/
│   ├── exchanges/
│   └── server/
├── frontend/               <-- Projeto Next.js
│   ├── src/
│   ├── node_modules/       <-- MÓDULOS DO FRONTEND
│   └── package.json        <-- Define as dependências do Frontend
├── node_modules/           <-- MÓDULOS DO BACKEND
├── package.json            <-- Define as dependências do Backend
└── package-lock.json       <-- Trava as versões das dependências do Backend            