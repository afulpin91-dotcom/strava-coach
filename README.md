# Strava Coach — app iPhone (PWA)

Une app qui s'installe sur l'écran d'accueil de l'iPhone. **Vos données restent sur le téléphone**
(stockage local du navigateur). L'hébergement ne contient que le code, jamais vos activités ni vos clés.

Fichiers à publier (à plat, 13 fichiers) : `index.html`, `app.js`, `engine.js`, `db.js`, `strava.js`, `importer.js`, `coach.js`,
`sw.js`, `manifest.webmanifest` et les 4 images `*.png`.
`worker.js` (relais Cloudflare, facultatif) n'est pas servi par l'app : il sert seulement à l'étape 4.

## 1. Publier l'app (une seule fois, ~10 min, gratuit)

1. Créez un compte sur github.com, puis un dépôt **public** nommé `strava-coach`.
2. Dans le dépôt : **Add file › Upload files**, sélectionnez les 13 fichiers, puis **Commit changes**.
   (Sur iPhone : dézippez d'abord l'archive dans l'app Fichiers.)
3. **Settings › Pages › Build and deployment** : Source = *Deploy from a branch*, branche `main`, dossier `/ (root)`.
   Au bout d'une ou deux minutes, l'adresse est `https://VOTRE-NOM.github.io/strava-coach/`.

## 2. Installer l'app sur l'iPhone

Ouvrez l'adresse de l'étape 1 dans **Safari** › Partager › **Sur l'écran d'accueil**, puis lancez l'app depuis l'icône.

## 3. Charger vos données (gratuit, sans l'API Strava)

Strava réserve son API aux abonnés ; l'export de vos données reste la voie gratuite.
1. Sur strava.com : Paramètres › Mon compte › « Télécharger ou supprimer votre compte » › demandez l'archive.
2. Téléchargez le ZIP reçu par e-mail.
3. Dans l'app : **Réglages › Importer mon export Strava**, choisissez le ZIP (ou des fichiers FIT / GPX / TCX).
   Un nouvel export plus tard n'ajoute que les nouveautés, sans doublons.

- Les fichiers **FIT** contiennent la fréquence cardiaque : zones précises. Les **GPX** n'en ont pas
  (distance, durée et dénivelé seulement).
- Strava n'indique pas dans les fichiers quelles activités sont des courses : touchez 🏁 sur une activité
  pour la marquer. Cela recalcule votre niveau et vos allures.
- Ensuite : créez votre objectif sur le tableau de bord.

## 4. (Option, abonnés Strava) Connexion directe à l'API

Réglages › « Connexion directe à Strava » : Client ID / Secret d'une application créée sur strava.com/settings/api
(« Authorization Callback Domain » = `VOTRE-NOM.github.io`), puis **Se connecter** ; si la page s'ouvre dans Safari,
copiez le code affiché et collez-le dans Réglages › Coller le code. Un bouton **Synchroniser** apparaît alors.
Si le test de connexion directe échoue (CORS), utilisez le relais Cloudflare :
1. dash.cloudflare.com › Workers & Pages › **Create** › Worker › collez `worker.js` › Deploy.
2. Settings › Variables : `CLIENT_ID`, `CLIENT_SECRET` (type *Secret*), `ALLOWED_ORIGIN` = `https://VOTRE-NOM.github.io`.
3. Réglages › « Adresse du relais » : l'adresse `https://….workers.dev`.

## Utiliser le plan

- **Vos jours :** à la création de l'objectif, cochez les jours où vous pouvez courir (3 à 6) et le jour de la sortie longue.
  Les séances dures sont placées loin de la sortie longue et jamais collées l'une à l'autre.
- **Déplacer une séance :** touchez ⇄ à côté de la séance et choisissez un autre jour de la même semaine
  (échange si le jour est pris). Le déplacement est conservé quand le plan se recalcule.
- **Suivi :** une séance faite un autre jour de la semaine compte (✓ « faite le … ») ; ⏳ = pas encore faite cette
  semaine ; ✗ n'apparaît qu'une fois la semaine terminée.
- **Pause (blessure, maladie) :** « Mettre en pause » retire les séances à venir ; à la reprise, le volume repart plus bas
  selon la durée de l'arrêt (−15 %, −30 % ou −45 %), sans rattrapage.
- **Niveau :** sans course, l'app l'estime depuis l'allure et la FC de vos sorties (il faut donc une FC max et une FC repos
  justes dans Réglages). « Affiner mon niveau » permet d'ajouter une course ou un test en quelques secondes.

## À savoir

- Limite de l'API (abonnés) : 100 requêtes par 15 min ; un premier import long peut s'interrompre (progression sauvegardée).
- Faites de temps en temps **Réglages › Exporter une sauvegarde** (fichier JSON, sans le secret).
  iOS peut vider les données d'un site peu utilisé ; une app installée est normalement épargnée.
- Mise à jour du code : modifiez `CACHE = 'strava-coach-v7'` dans `sw.js` (v2, v3…) pour forcer le rafraîchissement.
- Le moteur est vérifié identique à la version Python : `node tests/compare.mjs` (après `python3 tests/gen_reference.py`).
- Ce n'est pas un avis médical : en cas de douleur ou de fatigue anormale, levez le pied.
