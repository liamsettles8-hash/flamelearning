import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut as firebaseSignOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, updateDoc, getDoc, onSnapshot, serverTimestamp, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

window.FlameFirebase = {
  app, auth, db, provider,
  async google() {
    try { return await signInWithPopup(auth, provider); }
    catch (e) {
      if (e?.code === "auth/popup-blocked" || e?.code === "auth/popup-closed-by-user") throw e;
      return await signInWithRedirect(auth, provider);
    }
  },
  async email(email, password, register = false, name = "") {
    const result = register ? await createUserWithEmailAndPassword(auth, email, password) : await signInWithEmailAndPassword(auth, email, password);
    if (register && name) await updateProfile(result.user, { displayName: name });
    return result;
  },
  signOut: () => firebaseSignOut(auth),
  onAuth: (fn) => onAuthStateChanged(auth, fn),
  firestore: { collection, doc, setDoc, updateDoc, getDoc, onSnapshot, serverTimestamp, query, where, orderBy, limit }
};

try { await getRedirectResult(auth); } catch (e) { console.warn("[Firebase] redirect sign-in result:", e); }
