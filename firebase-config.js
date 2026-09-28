/* Firebaseの接続設定(端末間同期に使う)。
   Firebaseコンソール → プロジェクトの設定 → マイアプリ → 「SDKの設定と構成」の値をコピーする。
   ここに書く値は秘密情報ではなく、ブラウザに公開される前提の識別子。
   誰がどのデータを読み書きできるかは firestore.rules で制限している。
   apiKey が空のあいだは同期機能は「準備中」と表示され、アプリの他の機能はそのまま使える。 */
export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
