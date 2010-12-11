/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Weave.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2008
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Dan Mills <thunder@mozilla.com>
 *  Richard Newman <rnewman@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const EXPORTED_SYMBOLS = ["CryptoWrapper", "CollectionKeys", "BulkKeyBundle", "SyncKeyBundle"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/base_records/wbo.js");
Cu.import("resource://services-sync/identity.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/log4moz.js");

function CryptoWrapper(collection, id) {
  this.cleartext = {};
  WBORecord.call(this, collection, id);
  this.ciphertext = null;
  this.id = id;
}
CryptoWrapper.prototype = {
  __proto__: WBORecord.prototype,
  _logName: "Record.CryptoWrapper",

  ciphertextHMAC: function ciphertextHMAC(keyBundle) {
    let hmacKey = keyBundle.hmacKeyObject;
    if (!hmacKey)
      throw "Cannot compute HMAC with null key.";
    
    return Utils.sha256HMAC(this.ciphertext, hmacKey);
  },

  /*
   * Don't directly use the sync key. Instead, grab a key for this
   * collection, which is decrypted with the sync key.
   *
   * Cache those keys; invalidate the cache if the time on the keys collection
   * changes, or other auth events occur.
   *
   * Optional key bundle overrides the collection key lookup.
   */
  encrypt: function encrypt(keyBundle) {

    keyBundle = keyBundle || CollectionKeys.keyForCollection(this.collection);
    if (!keyBundle)
      throw new Error("Key bundle is null for " + this.uri.spec);

    this.IV = Svc.Crypto.generateRandomIV();
    this.ciphertext = Svc.Crypto.encrypt(JSON.stringify(this.cleartext),
                                         keyBundle.encryptionKey, this.IV);
    this.hmac = this.ciphertextHMAC(keyBundle);
    this.cleartext = null;
  },

  // Optional key bundle.
  decrypt: function decrypt(keyBundle) {
    
    if (!this.ciphertext) {
      throw "No ciphertext: nothing to decrypt?";
    }

    keyBundle = keyBundle || CollectionKeys.keyForCollection(this.collection);
    if (!keyBundle)
      throw new Error("Key bundle is null for " + this.collection + "/" + this.id);

    // Authenticate the encrypted blob with the expected HMAC
    let computedHMAC = this.ciphertextHMAC(keyBundle);

    if (computedHMAC != this.hmac) {
      Utils.throwHMACMismatch(this.hmac, computedHMAC);
    }

    // Handle invalid data here. Elsewhere we assume that cleartext is an object.
    let json_result = JSON.parse(Svc.Crypto.decrypt(this.ciphertext,
                                                    keyBundle.encryptionKey, this.IV));
    
    if (json_result && (json_result instanceof Object)) {
      this.cleartext = json_result;
    this.ciphertext = null;
    }
    else {
      throw "Decryption failed: result is <" + json_result + ">, not an object.";
    }

    // Verify that the encrypted id matches the requested record's id.
    if (this.cleartext.id != this.id)
      throw "Record id mismatch: " + [this.cleartext.id, this.id];

    return this.cleartext;
  },

  toString: function CryptoWrap_toString() "{ " + [
      "id: " + this.id,
      "index: " + this.sortindex,
      "modified: " + this.modified,
      "payload: " + (this.deleted ? "DELETED" : JSON.stringify(this.cleartext)),
      "collection: " + (this.collection || "undefined")
    ].join("\n  ") + " }",

  // The custom setter below masks the parent's getter, so explicitly call it :(
  get id() WBORecord.prototype.__lookupGetter__("id").call(this),

  // Keep both plaintext and encrypted versions of the id to verify integrity
  set id(val) {
    WBORecord.prototype.__lookupSetter__("id").call(this, val);
    return this.cleartext.id = val;
  },
};

Utils.deferGetSet(CryptoWrapper, "payload", ["ciphertext", "IV", "hmac"]);
Utils.deferGetSet(CryptoWrapper, "cleartext", "deleted");

Utils.lazy(this, "CollectionKeys", CollectionKeyManager);


/**
 * Keeps track of mappings between collection names ('tabs') and
 * keyStrs, which you can feed into KeyBundle to get encryption tokens.
 *
 * You can update this thing simply by giving it /info/collections. It'll
 * use the last modified time to bring itself up to date.
 */
function CollectionKeyManager() {
  this._lastModified = 0;
  this._collections = {};
  this._default = null;
  
  this._log = Log4Moz.repository.getLogger("CollectionKeys");
}

// TODO: persist this locally as an Identity. Bug 610913.
// Note that the last modified time needs to be preserved.
CollectionKeyManager.prototype = {
  
  // Return information about old vs new keys:
  // * same: true if two collections are equal
  // * changed: an array of collection names that changed.
  _compareKeyBundleCollections: function _compareKeyBundleCollections(m1, m2) {
    let changed = [];
    
    function process(m1, m2) {
      for (let k1 in m1) {
        let v1 = m1[k1];
        let v2 = m2[k1];
        if (!(v1 && v2 && v1.equals(v2)))
          changed.push(k1);
      }
    }
    
    // Diffs both ways.
    process(m1, m2);
    process(m2, m1);
    
    // Return a sorted, unique array.
    changed.sort();
    let last;
    changed = [x for each (x in changed) if ((x != last) && (last = x))];
    return {same: changed.length == 0,
            changed: changed};
  },
  
  get isClear() {
   return !this._default;
  },
  
  clear: function clear() {
    this._log.info("Clearing CollectionKeys...");
    this._lastModified = 0;
    this._collections = {};
    this._default = null;
  },
  
  keyForCollection: function(collection) {
                      
    // Moderately temporary debugging code.
    this._log.trace("keyForCollection: " + collection + ". Default is " + (this._default ? "not null." : "null."));
    
    if (collection && this._collections[collection])
      return this._collections[collection];
    
    return this._default;
  },

  /**
   * If `collections` (an array of strings) is provided, iterate
   * over it and generate random keys for each collection.
   */
  generateNewKeys: function(collections) {
    let newDefaultKey = new BulkKeyBundle(null, DEFAULT_KEYBUNDLE_NAME);
    newDefaultKey.generateRandom();
    
    let newColls = {};
    if (collections) {
      collections.forEach(function (c) {
        let b = new BulkKeyBundle(null, c);
        b.generateRandom();
        newColls[c] = b;
      });
    }
    this._default = newDefaultKey;
    this._collections = newColls;
    this._lastModified = (Math.round(Date.now()/10)/100);
  },

  asWBO: function(collection, id) {
    let wbo = new CryptoWrapper(collection || "crypto", id || "keys");
    let c = {};
    for (let k in this._collections) {
      c[k] = this._collections[k].keyPair;
    }
    wbo.cleartext = {
      "default": this._default ? this._default.keyPair : null,
      "collections": c,
      "id": id,
      "collection": collection
    };
    wbo.modified = this._lastModified;
    return wbo;
  },

  // Take the fetched info/collections WBO, checking the change
  // time of the crypto collection.
  updateNeeded: function(info_collections) {

    this._log.info("Testing for updateNeeded. Last modified: " + this._lastModified);

    // No local record of modification time? Need an update.
    if (!this._lastModified)
      return true;

    // No keys on the server? We need an update, though our
    // update handling will be a little more drastic...
    if (!("crypto" in info_collections))
      return true;

    // Otherwise, we need an update if our modification time is stale.
    return (info_collections["crypto"] > this._lastModified);
  },

  // 
  // Set our keys and modified time to the values fetched from the server.
  // Returns one of three values:
  // 
  // * If the default key was modified, return true.
  // * If the default key was not modified, but per-collection keys were,
  //   return an array of such.
  // * Otherwise, return false -- we were up-to-date.
  // 
  setContents: function setContents(payload, modified) {
                 
    let self = this;
    
    // The server will round the time, which can lead to us having spurious
    // key refreshes. Do the best we can to get an accurate timestamp, but
    // rounded to 2 decimal places.
    // We could use .toFixed(2), but that's a little more multiplication and
    // division...
    function bumpModified() {
      let lm = modified || (Math.round(Date.now()/10)/100);
      self._log.info("Bumping last modified to " + lm);
      self._lastModified = lm;
    }
    
    this._log.info("Setting CollectionKeys contents. Our last modified: "
        + this._lastModified + ", input modified: " + modified + ".");
    
    if (!payload)
      throw "No payload in CollectionKeys.setContents().";
    
    if (!payload.default) {
      this._log.warn("No downloaded default key: this should not occur.");
      this._log.warn("Not clearing local keys.");
      throw "No default key in CollectionKeys.setContents(). Cannot proceed.";
    }
    
    // Process the incoming default key.
    let b = new BulkKeyBundle(null, DEFAULT_KEYBUNDLE_NAME);
    b.keyPair = payload.default;
    let newDefault = b;
    
    // Process the incoming collections.
    let newCollections = {};
    if ("collections" in payload) {
      this._log.info("Processing downloaded per-collection keys.");
      let colls = payload.collections;
      for (let k in colls) {
        let v = colls[k];
        if (v) {
          let keyObj = new BulkKeyBundle(null, k);
          keyObj.keyPair = v;
          if (keyObj) {
            newCollections[k] = keyObj;
          }
        }
      }
    }
    
    // Check to see if these are already our keys.
    let sameDefault = (this._default && this._default.equals(newDefault));
    let collComparison = this._compareKeyBundleCollections(newCollections, this._collections);
    let sameColls = collComparison.same;
    
    if (sameDefault && sameColls) {
      this._log.info("New keys are the same as our old keys! Bumping local modified time and returning.");
      bumpModified();
      return false;
    }
      
    // Make sure things are nice and tidy before we set.
    this.clear();
    
    this._log.info("Saving downloaded keys.");
    this._default     = newDefault;
    this._collections = newCollections;
    
    bumpModified();
    
    return sameDefault ? collComparison.changed : true;
  },

  updateContents: function updateContents(syncKeyBundle, storage_keys) {
    let log = this._log;
    log.info("Updating collection keys...");
    
    // storage_keys is a WBO, fetched from storage/crypto/keys.
    // Its payload is the default key, and a map of collections to keys.
    // We lazily compute the key objects from the strings we're given.
    
    let payload;
    try {
      payload = storage_keys.decrypt(syncKeyBundle);
    } catch (ex) {
      log.warn("Got exception \"" + ex + "\" decrypting storage keys with sync key.");
      log.info("Aborting updateContents. Rethrowing.");
      throw ex;
    }

    let r = this.setContents(payload, storage_keys.modified);
    log.info("Collection keys updated.");
    return r;
  }
}

/**
 * Abuse Identity: store the collection name (or default) in the
 * username field, and the keyStr in the password field.
 *
 * We very rarely want to override the realm, so pass null and
 * it'll default to PWDMGR_KEYBUNDLE_REALM.
 * 
 * KeyBundle is the base class for two similar classes:
 * 
 * SyncKeyBundle:
 *
 *   A key string is provided, and it must be hashed to derive two different
 *   keys (one HMAC, one AES).
 *
 * BulkKeyBundle:
 *
 *   Two independent keys are provided, or randomly generated on request.
 * 
 */
function KeyBundle(realm, collectionName, keyStr) {
  let realm = realm || PWDMGR_KEYBUNDLE_REALM;
  
  if (keyStr && !keyStr.charAt)
    // Ensure it's valid.
    throw "KeyBundle given non-string key.";
  
  Identity.call(this, realm, collectionName, keyStr);
  this._hmac    = null;
  this._encrypt = null;
  
  // Cache the key object.
  this._hmacObj = null;
}

KeyBundle.prototype = {
  __proto__: Identity.prototype,
  
  equals: function equals(bundle) {
    return bundle &&
           (bundle.hmacKey == this.hmacKey) &&
           (bundle.encryptionKey == this.encryptionKey);
  },
  
  /*
   * Accessors for the two keys.
   */
  get encryptionKey() {
    return this._encrypt;
  },
  
  set encryptionKey(value) {
    this._encrypt = value;
  },

  get hmacKey() {
    return this._hmac;
  },
  
  set hmacKey(value) {
    this._hmac = value;
    this._hmacObj = value ? Utils.makeHMACKey(value) : null;
  },
  
  get hmacKeyObject() {
    return this._hmacObj;
  },
}

function BulkKeyBundle(realm, collectionName) {
  let log = Log4Moz.repository.getLogger("BulkKeyBundle");
  log.info("BulkKeyBundle being created for " + collectionName);
  KeyBundle.call(this, realm, collectionName);
}

BulkKeyBundle.prototype = {
  __proto__: KeyBundle.prototype,
   
  generateRandom: function generateRandom() {
    let generatedHMAC = Svc.Crypto.generateRandomKey();
    let generatedEncr = Svc.Crypto.generateRandomKey();
    this.keyPair = [generatedEncr, generatedHMAC];
  },
  
  get keyPair() {
    return [this._encrypt, btoa(this._hmac)];
  },
  
  /*
   * Use keyPair = [enc, hmac], or generateRandom(), when
   * you want to manage the two individual keys.
   */
  set keyPair(value) {
    if (value.length && (value.length == 2)) {
      let json = JSON.stringify(value);
      let en = value[0];
      let hm = value[1];
      
      this.password = json;
      this.hmacKey  = Utils.safeAtoB(hm);
      this._encrypt = en;          // Store in base64.
    }
    else {
      throw "Invalid keypair";
  }
  },
};

function SyncKeyBundle(realm, collectionName, syncKey) {
  let log = Log4Moz.repository.getLogger("SyncKeyBundle");
  log.info("SyncKeyBundle being created for " + collectionName);
  KeyBundle.call(this, realm, collectionName, syncKey);
  if (syncKey)
    this.keyStr = syncKey;      // Accessor sets up keys.
} 

SyncKeyBundle.prototype = {
  __proto__: KeyBundle.prototype,

  /*
   * Use keyStr when you want to work with a key string that's
   * hashed into individual keys.
   */
  get keyStr() {
    return this.password;
  },

  set keyStr(value) {
    this.password = value;
    this._hmac    = null;
    this._hmacObj = null;
    this._encrypt = null;
    this.generateEntry();
  },
  
  /*
   * Can't rely on password being set through any of our setters:
   * Identity does work under the hood.
   * 
   * Consequently, make sure we derive keys if that work hasn't already been
   * done.
   */
  get encryptionKey() {
    if (!this._encrypt)
      this.generateEntry();
    return this._encrypt;
  },
  
  get hmacKey() {
    if (!this._hmac)
      this.generateEntry();
    return this._hmac;
  },
  
  get hmacKeyObject() {
    if (!this._hmacObj)
      this.generateEntry();
    return this._hmacObj;
  },
  
  /*
   * If we've got a string, hash it into keys and store them.
   */
  generateEntry: function generateEntry() {
    let syncKey = this.keyStr;
    if (!syncKey)
      return;

    // Expand the base32 Sync Key to an AES 256 and 256 bit HMAC key.
    let prk = Utils.decodeKeyBase32(syncKey);
    let info = HMAC_INPUT + this.username;
    let okm = Utils.hkdfExpand(prk, info, 32 * 2);
    let enc = okm.slice(0, 32);
    let hmac = okm.slice(32, 64);

    // Save them.
    this._encrypt = btoa(enc);      
    // Individual sets: cheaper than calling parent setter.
    this._hmac = hmac;
    this._hmacObj = Utils.makeHMACKey(hmac);
  }
};