/* This is the background page for gmail-crypt that communicates between gmail and the extension.
 *
 * Copyright 2011 Sean Colyer, <sean @ colyer . name>
 * This program is licensed under the GNU General Public License Version 2.
 * See included "LICENSE" file for details.
 */

var keyring,
    config;

//Grouping all alerts in one place, easy to access. Consider moving .html to a format function, since they are heavily pattern based.
var gCryptAlerts = {
  gCryptAlertDecryptNoMessage : {id: 'gCryptAlertDecryptNoMessage', type: 'error', text: 'No OpenPGP message was found.',
    html: '<div class="alert alert-error" id="gCryptAlertDecryptNoMessage">No OpenPGP message was found.</div>' },
  gCryptAlertDecryptNoCleartextMessage : {id: 'gCryptAlertDecryptNoCleartextMessage', type: 'error', text: 'No signed, cleartext OpenPGP message was found. Was this message also encrypted?',
    html: '<div class="alert alert-error" id="gCryptAlertDecryptNoCleartextMessage">No signed, cleartext OpenPGP message was found. Was this message also encrypted?</div>' },
  gCryptUnableVerifySignature: {id: 'gCryptUnableVerifySignature', type: '', text: 'Mymail-Crypt For Gmail was unable to verify this message.',
    html: '<div class="alert" id="gCryptUnableVerifySignature">Mymail-Crypt For Gmail was unable to verify this message.</div>' },
  gCryptAbleVerifySignature: {id: 'gCryptAbleVerifySignature', type: 'success', text: 'Mymail-Crypt For Gmail was able to verify this message.',
    html: '<div class="alert alert-success" id="gCryptAbleVerifySignature">Mymail-Crypt For Gmail was able to verify this message.</div>'},
  gCryptAlertPassword: {id: 'gCryptAlertPassword', type: 'error', text: 'Mymail-Crypt For Gmail was unable to read your key. Is your password correct?',
    html: '<div class="alert alert-error" id="gCryptAlertPassword">Mymail-Crypt For Gmail was unable to read your key. Is your password correct?</div>'},
  gCryptAlertDecrypt: {id: 'gCryptAlertDecrypt', type: 'error', text: 'Mymail-Crypt for Gmail was unable to decrypt this message.',
    html: '<div class="alert alert-error" id="gCryptAlertDecrypt">Mymail-Crypt for Gmail was unable to decrypt this message.</div>'},
  gCryptAlertEncryptNoUser: {id: 'gCryptAlertEncryptNoUser', type: 'error', text: 'Unable to find a key for the given user. Have you inserted their public key?',
    html: '<div class="alert alert-error" id="gCryptAlertEncryptNoUser">Unable to find a key for the given user. Have you inserted their public key?</div>'},
  gCryptAlertEncryptNoPrivateKeys: {id: 'gCryptAlertEncryptNoPrivateKeys', type: 'error', text: 'Unable to find a private key for the given user. Have you inserted yours in the Options page?',
    html: '<div class="alert alert-error" id="gCryptAlertEncryptNoUser">Unable to find a private key for the given user. Have you inserted yours in the Options page?</div>'}
};


function getKeys(keyIds, keyringSet) {
  var keys = [];
  keyIds.forEach(function(keyId){
    keys.push(keyringSet.getForId(keyId.toHex(), true));
  });
  return keys;
}

function prepareAndValidatePrivateKey(password, from) {
  var privateKeys = keyring.privateKeys.getForAddress(from);
  if (_.isEmpty(privateKeys)) {
    return gCryptAlerts.gCryptAlertEncryptNoPrivateKeys;
  }

  var privateKey = _(privateKeys).find(function(key) {
    return (key.decrypt() || key.decrypt(password));
  });

  return privateKey || gCryptAlerts.gCryptAlertPassword;
}

function prepareAndValidateKeysForRecipients(recipients, from) {
  var keys = [];
  var includeMyKey = gCryptUtil.getOption(config, 'includeMyself', true);

  _(recipients.email).each(function(email) {
    var publicKeyResult = keyring.publicKeys.getForAddress(email);
    if (!_.isEmpty(publicKeyResult)) {
      keys.push(publicKeyResult[0]);
    }
  });

  if (_.isEmpty(keys)){
    return gCryptAlerts.gCryptAlertEncryptNoUser;
  }

  if (includeMyKey) {
    keys = _.compact(keys.concat(keyring.publicKeys.getForAddress(from)));
  }
  return keys;
}

function encryptAndSign(recipients, from, message, password, callback) {
  var promise;
  var privKey = prepareAndValidatePrivateKey(password, from);
  var publicKeys = prepareAndValidateKeysForRecipients(recipients, from);
  if(privKey.type && privKey.type == "error") {
    promise = Promise.resolve(privKey);
  }
  else if(publicKeys.type && publicKeys.type == "error") {
    promise = Promise.resolve(publicKeys);
  }
  else {
    promise = openpgp.signAndEncryptMessage(publicKeys, privKey, message);
  }
  handleResponsePromise(promise, callback);
}

function encrypt(recipients, from, message, callback) {
  var promise;
  var publicKeys = prepareAndValidateKeysForRecipients(recipients, from);
  if(publicKeys && publicKeys.type && publicKeys.type == "error") {
    promise = Promise.resolve(publicKeys);
  }
  else {
    promise = openpgp.encryptMessage(publicKeys, message);
  }
  handleResponsePromise(promise, callback);
}

function sign(message, password, from, callback) {
  var promise;
  var privKey = prepareAndValidatePrivateKey(password, from);
  if(privKey && privKey.type && privKey.type == "error") {
    promise = Promise.resolve(privKey);
  }
  else {
    //TODO use privKeys because openpgp.js wants this to be an array. Should unify it's interface.
    var privKeys = [privKey];
    promise = openpgp.signClearMessage(privKeys, message);
  }
  handleResponsePromise(promise, callback);
}

var decryptResult = function(decrypted, status, result, callback) {
  output = {};
  output.decrypted = decrypted;
  output.status = status;
  output.result = result;
  var promise = Promise.resolve(output);
  handleResponsePromise(promise, callback);
};

function decrypt(senderEmail, msg, password, callback) {
  var status = [];
  try{
    msg = openpgp.message.readArmored(msg);
  }
  catch (e) {
    status.push(gCryptAlerts.gCryptAlertDecryptNoMessage);
    decryptResult(false, status, undefined, callback);
  }
  var keyIds = msg.getEncryptionKeyIds();
  var privateKeys = getKeys(keyIds, keyring.privateKeys);
  if (_.size(privateKeys) === 0) {
    status.push(gCryptAlerts.gCryptAlertDecrypt);
    decryptResult(false, status, undefined, callback);
  }
  var publicKeys = keyring.publicKeys.getForAddress(senderEmail);
  for (var r = 0; r < privateKeys.length; r++){
    var key = privateKeys[r];
    if (!key.decryptKeyPacket(keyIds, password)) {
      //TODO this could be generate false positive errors if we privateKeys really has multiple hits
      status.push(gCryptAlerts.gCryptAlertPassword);
    }

    var promise = openpgp.decryptAndVerifyMessage(key, publicKeys, msg);
    promise.then(function(result) {
      _(result.signatures).each(function(signature) {
        if (signature.valid) {
          status = [gCryptAlerts.gCryptAbleVerifySignature];
        }
      });
      if (status.length === 0) {
        status = [gCryptAlerts.gCryptUnableVerifySignature];
      }
      decryptResult(true, status, result, callback);

    }).catch(function(exception) {
      status.push(gCryptAlerts.gCryptAlertDecrypt);
      decryptResult(false, status, undefined, callback);
    });
  }
}

function verify(senderEmail, msg, callback) {
  var status = [];
  try{
    msg = openpgp.cleartext.readArmored(msg);
  }
  catch (e) {
    status.push(gCryptAlerts.gCryptAlertDecryptNoCleartextMessage);
    decryptResult(false, status, undefined, callback);
  }
  var publicKeys = keyring.publicKeys.getForAddress(senderEmail);
  var promise = openpgp.verifyClearSignedMessage(publicKeys, msg);
  promise.then(function(result) {
    status.push(gCryptAlerts.gCryptAbleVerifySignature);
    decryptResult(true, status, result, callback);

  }).catch(function(exception) {
    status.push(gCryptAlerts.gCryptUnableVerifySignature);
    decryptResult(false, status, undefined, callback);
  });
}

function handleResponsePromise(promise, callback) {
  promise.then(function(result) {
    callback(result);
  });
}

chrome.extension.onRequest.addListener(function(request, sender, callback){
    var result;
    //config can change at anytime, reload on request
    config.read();
    openpgp.config = config.config;
    // keys can be changed in options. This prevents force page reloading
    keyring.publicKeys.keys = keyring.storeHandler.loadPublic();
    keyring.privateKeys.keys = keyring.storeHandler.loadPrivate();

    if (request.method == "encryptAndSign") {
      result = encryptAndSign(request.recipients, request.from, request.message, request.password, callback);
    }
    else if (request.method == "encrypt") {
      result = encrypt(request.recipients, request.from, request.message, callback);
    }
    else if (request.method == "sign") {
      result = sign(request.message, request.password, request.from, callback);
    }
    else if (request.method == "decrypt") {
      result = decrypt(request.senderEmail, request.msg, request.password, callback);
    }
    else if (request.method == "verify") {
      result = verify(request.senderEmail, request.msg, callback);
    }
    else if(request.method == "getOption") {
      result = gCryptUtil.getOption(config, request.option, request.thirdParty, callback);
    }
    else{
      throw new Error("Unsupported Operation");
    }
});

document.onload = function() {
  keyring = new openpgp.Keyring();
  gCryptUtil.migrateOldKeys(keyring);
  //TODO openpgp.js needs to improve config support, this is a hack.
  config = new openpgp.config.localStorage();
  config.read();
  openpgp.config = config.config;
}();
