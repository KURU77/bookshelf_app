/* Firebaseの接続設定(端末間同期に使う)。
   Firebaseコンソール → Project settings → Your apps → 「SDK setup and configuration」の値。
   ここに書く値は秘密情報ではなく、ブラウザに公開される前提の識別子。
   誰がどのデータを読み書きできるかは firestore.rules で制限している。
   (measurementId はアクセス解析用のため、解析を使わないこのアプリでは設定しない) */
export const firebaseConfig = {
  apiKey: "AIzaSyCr9zCtMa553t5574KLxUaJe1Z0TNJnoME",
  authDomain: "mybookshelf-e7770.firebaseapp.com",
  projectId: "mybookshelf-e7770",
  storageBucket: "mybookshelf-e7770.firebasestorage.app",
  messagingSenderId: "306538737132",
  appId: "1:306538737132:web:39c338410115946a3c64c9"
};
