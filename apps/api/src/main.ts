import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Limite Express par défaut (100kb) trop basse pour la soumission KYC (document d'identité
  // encodé en base64, jusqu'à ~3 Mo) — relevée explicitement plutôt que de casser cet endpoint.
  app.use(json({ limit: '6mb' }));
  app.use(urlencoded({ extended: true, limit: '6mb' }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.use(
    helmet({
      // demo.html s'appuie sur des onclick= et un <script> inline — un CSP strict le casserait.
      // On garde quand même les autres protections (clickjacking, MIME sniffing, etc.) et un CSP
      // qui limite au moins les sources externes à celles réellement utilisées (socket.io via CDN).
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
          // helmet ajoute par défaut `script-src-attr 'none'`, qui bloque TOUS les onclick=/onchange=
          // de demo.html (boutons Connexion, navigation, ordres... rien ne répondait). scriptSrc ne
          // couvre que les balises <script>, pas les attributs : il faut l'assouplir séparément.
          // Compromis assumé et cohérent avec 'unsafe-inline' ci-dessus ; la vraie défense contre le
          // XSS reste l'échappement esc() de toute donnée API. À terme : passer à addEventListener
          // (délégation d'événements) pour pouvoir remettre 'none'.
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'wss:', 'https:'],
        },
      },
    }),
  );
  // Ouvert par défaut (les tokens sont Bearer, pas des cookies, donc le risque CORS classique
  // est limité) — restreindre via ALLOWED_ORIGINS ("a.com,b.com") une fois le domaine final fixé.
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim());
  app.enableCors(allowedOrigins ? { origin: allowedOrigins } : undefined);
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[api] Phase 0 — écoute sur http://localhost:${port}`);
}
bootstrap();
