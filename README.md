# Strava Coach — app iPhone (PWA)

Une app qui s'installe sur l'écran d'accueil de l'iPhone. **Vos données restent sur le téléphone**
(stockage local du navigateur). L'hébergement ne contient que le code, jamais vos activités ni vos clés.

Fichiers à publier (à plat, 12 fichiers) : `index.html`, `app.js`, `engine.js`, `db.js`, `strava.js`, `coach.js`,
`sw.js`, `manifest.webmanifest` et les 4 images `*.png`.
Les dossiers `relay/` et `tests/` ne se publient pas.

## 1. Publier l'app (une seule fois, ~10 min, gratuit)

1. Créez un compte sur github.com, puis un dépôt **public** nommé `strava-coach`.
2. Dans le dépôt : **Add file › Upload files**, sélectionnez les 12 fichiers, puis **Commit changes**.
   (Sur iPhone : dézippez d'abord l'archive dans l'app Fichiers.)
3. **Settings › Pages › Build and deployment** : Source = *Deploy from a branch*, branche `main`, dossier `/ (root)`.
   Au bout d'une ou deux minutes, l'adresse est `https://VOTRE-NOM.github.io/strava-coach/`.

## 2. Créer l'application Strava

Sur https://www.strava.com/settings/api : créez une application.
- **Authorization Callback Domain** : `VOTRE-NOM.github.io` (sans `https://`, sans chemin).
- Notez le Client ID et le Client Secret.

## 3. Installer et connecter (sur l'iPhone)

1. Ouvrez l'adresse de l'étape 1 dans **Safari** › Partager › **Sur l'écran d'accueil**.
2. Lancez l'app depuis l'icône › **Réglages** : Client ID, Client Secret, FC max, FC repos › Enregistrer.
3. **Tester la connexion directe** : si ça passe, vous n'avez pas besoin du relais (étape 4).
4. **Se connecter à Strava**, autorisez en laissant « Voir toutes vos activités » coché.
5. Après l'autorisation, iOS peut rouvrir la page dans Safari plutôt que dans l'app (le stockage est séparé).
   Dans ce cas la page affiche un **code** : copiez-le, revenez dans l'app installée › Réglages › **Coller le code**.
6. Retour sur le tableau de bord › **Synchroniser** (cochez « détails FC » pour des zones précises), puis créez votre objectif.

## 4. Relais (seulement si le test de l'étape 3 échoue)

Certains appels Strava peuvent être refusés par le navigateur. Le relais est un petit script gratuit, à vous :
1. dash.cloudflare.com › Workers & Pages › **Create** › Worker › collez `relay/worker.js` › Deploy.
2. Settings › Variables : `CLIENT_ID`, `CLIENT_SECRET` (type *Secret*), `ALLOWED_ORIGIN` = `https://VOTRE-NOM.github.io`.
3. Dans l'app › Réglages › « Adresse du relais » : l'adresse `https://….workers.dev`. Le Client Secret n'a alors plus besoin d'être saisi sur le téléphone.

## À savoir

- La limite gratuite de Strava est de 100 requêtes par 15 min : un premier import long peut s'interrompre
  (progression sauvegardée, relancez plus tard).
- Faites de temps en temps **Réglages › Exporter une sauvegarde** (fichier JSON, sans le secret).
  iOS peut vider les données d'un site peu utilisé ; une app installée est normalement épargnée.
- Mise à jour du code : modifiez `CACHE = 'strava-coach-v1'` dans `sw.js` (v2, v3…) pour forcer le rafraîchissement.
- Le moteur est vérifié identique à la version Python : `node tests/compare.mjs` (après `python3 tests/gen_reference.py`).
- Ce n'est pas un avis médical : en cas de douleur ou de fatigue anormale, levez le pied.
