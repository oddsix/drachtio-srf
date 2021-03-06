var Dialog = require('./dialog') ;
var assert = require('assert') ;
var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var delegate = require('delegates') ;
var _ = require('lodash') ;
var assert = require('assert') ;
var parser = require('drachtio-sip').parser ;
var methods = require('sip-methods') ;
var SipError = require('./sip_error') ;
var Q = require('q');
var async = require('async') ;
var debug = require('debug')('drachtio-srf') ;


/**
 * Creates a signaling resource framework instance.
 * @constructor
 * @param {Object} app - drachtio app 
 */
function Srf( app ) {
  assert.equal( typeof app, 'function', 'argument \'app\' was not provided or was not a drachtio app') ;

  if (!(this instanceof Srf)) { return new Srf(app); }

  Emitter.call(this); 

  this._app = app ;
  this.dialogs = {} ;

  app.use( this.dialog() ) ;

}
util.inherits(Srf, Emitter) ;

module.exports = exports = Srf ;

/*
 * drachtio middleware that enables Dialog handling
 * @param  {Object} opts - configuration arguments, if any (currently unused)
 */
Srf.prototype.dialog = function(opts) {
  var self = this ;

  opts = opts || {} ;

  return function(req, res, next) {

    debug('examining %s, dialog id: ', req.method, req.stackDialogId ); 
    debug('current dialogs: ', _.keys( self.dialogs )) ;
    if( req.stackDialogId && req.stackDialogId in self.dialogs) {
      debug('calling dialog handler'); 
      var dialog = self.dialogs[req.stackDialogId] ;
      dialog.handle( req, res, next) ;
      return ;
    }
    next() ;
  } ;
} ;

/**
 * respond to an incoming INVITE message by creating a user-agent server (UAS) dialog
 *   
 * @param  {Request}   req    incoming drachtio Request object, received in app.invite(...) method
 * @param  {Response}  res    drachtio Response passed with incoming request
 * @param  {Srf~uasOptions}    opts   configuration options
 * @param {Srf~dialogCreationCallback} cb      callback that provides the created Dialog
 */
Srf.prototype.createUasDialog = function( req, res, opts, cb ) {
  assert.ok( !!req.msg, 'argument \'req\' must be a drachtio Request') ;
  assert.equal( typeof res.agent, 'object', 'argument \'res\' must be a drachtio Response') ;
  assert.equal( typeof opts, 'object', 'argument \'opts\' must be provided with connection options') ;
  assert.equal( typeof opts.localSdp,'string', 'argument \'opts.localSdp\' was not provided') ;
  assert.equal( typeof cb, 'function', 'a callback function is required'); 

  var self = this ;

  opts.headers = opts.headers || {} ;

  res.send( 200, {
    headers: opts.headers,
    body: opts.localSdp
  }, function(err, response) {
    if( err ) { return cb(err) ; }

    var dialog = new Dialog(self, 'uas', {req: req, res: res, sent: response} ) ;
    dialog.once('ack', function() {
      cb( null, dialog ) ;
    }) ;
    self.addDialog( dialog );
  }); 

  req.on('cancel', function() {
    debug('Srf#createUasDialog: received CANCEL from uac') ;
    cb( new SipError( 487, 'Request Terminated')) ;
  }) ;
} ;

/**
 * create a user-agent client (UAC) dialog by generating an INVITE request
 *   
 * @param  {RequestUri}   uri -  request uri to send to 
 * @param  {Srf~uacOptions}   opts   configuration options
 * @param {Srf~dialogCreationCallback} cb      callback that provides the created Dialog
 * @param {Srf~provisionalResponseCallback} [cbProvisional]  callback that passes on provisional responses
 * @param {Srf~cancelCallback} [cbCancel]  callback that passes on provisional responses
 * @returns {Promise} promise fulfilled with the request that is actually sent
 */
Srf.prototype.createUacDialog = function( uri, opts, cb, cbProvisional ) {
  var self = this ;

  var deferred = Q.defer();

  if( typeof uri === 'string' ) { opts.uri = uri ;}
  else if( typeof uri === 'object' ) { 
    cbProvisional = cb ;
    cb = opts ;
    opts = uri ;
  }
  opts.headers = opts.headers || {} ;

  assert.ok( !!opts.uri, 'uri must be specified' ) ;
  assert.equal( typeof opts.localSdp, 'string', 'argument \'opts.localSdp\' was not provided') ;
  assert.equal( typeof cb, 'function', 'a callback function is required') ;

  var parsed = parser.parseUri( opts.uri ) ;
  if( !parsed ) {
    if( -1 === opts.uri.indexOf('@') ) {
      var address = opts.uri ;
      opts.uri = 'sip:' + (opts.calledNumber ? opts.calledNumber + '@' : '') + address ;
    }
    else {
      opts.uri = 'sip:' + opts.uri ;
    }
  }

  if( opts.callingNumber ) {
    opts.headers.from = 'sip:' + opts.callingNumber + '@localhost' ;
    opts.headers.contact = 'sip:' + opts.callingNumber + '@localhost' ;
  }

  this._app.request({
      uri: opts.uri,
      method: 'INVITE',
      headers: opts.headers,
      body: opts.localSdp
    },
    function( err, req ){
      if( err ) { 
        deferred.reject(err) ;
        return cb(err) ; 
      }
      deferred.resolve(req) ;
      req.on('response', function(res, ack) {
        if( res.status >= 200 ) {
          ack() ;

          if( 200 === res.status ) {
            var dialog = new Dialog(self, 'uac', {req: req, res: res} ) ;
            self.addDialog( dialog ) ;
            return cb(null, dialog) ;
          }

          cb( new SipError(res.status, res.reason) ) ;
        }
        else if( cbProvisional ) {
          cbProvisional( res ) ;
        }
      }) ;
    }
  ) ;
  
  return deferred.promise;
} ;
/**
 * This callback provides the response to an api request.
 * @callback Srf~dialogCreationCallback
 * @param {Error} err   error returned on non-success
 * @param {Dialog} dialog Dialog object created on success
 */

/**
 * create back-to-back dialogs; i.e. act as a back-to-back user agent
 * @param  {Request}   req  - incoming drachtio Request object, received in app.invite(...) method
 * @param  {Response}   res  - drachtio Response passed with incoming request
 * @param  {String|Array}  uri] - an IP address[:port], or list of same, to send the B leg to
 * @param  {Srf~b2bOptions}  [opts] -   configuration options
 * @param  {Srf~b2bDialogCreationCallback} cb - callback invoked when operation is completed
 */
Srf.prototype.createBackToBackDialogs = function( req, res, uri, opts, cb ) {
  assert.ok(  _.isString(uri) || _.isArray(uri), 'argument \'uri\' must be either a string or an array') ;

  var self = this ;
  if( typeof opts === 'function') {
    cb = opts ;
    opts = {} ;
  }

  assert.ok(  !opts.onProvisional || typeof opts.onProvisional === 'function', 'argument \'opts.onProvisional\' must be a function') ;

  var onProvisional = opts.onProvisional ;

  // default From, To, and user part of uri if not provided
  opts.headers = opts.headers || {} ;
  _.each( opts.headers, function( value, hdr ) { opts.headers[hdr.toLowerCase] = value ; }) ;
  if( !opts.headers.from && !opts.callingNumber ) { opts.callingNumber = req.callingNumber; }
  if( !opts.headers.to && !opts.calledNumber ) { opts.calledNumber = req.calledNumber; }

  opts.localSdp = opts.localSdpB || req.body ;
  var localSdpA = opts.localSdpA ;

  uri = 'string' === typeof uri ? [uri] : uri ;

  var finalUacFail ;
  var finalUacSuccess ;
  var receivedProvisional = false ;
  var canceled = false ;
  var uacBye ;

  // DH: NOTE (possible TODO): callback signature changes in async 2.x for detectXXX
  async.detectSeries( 
    uri, 
    function truthTest( uri, callback) {
      
      if( receivedProvisional || canceled ) { 
        // stop cranking back once we receive a provisional > 100 from somebody or the caller canceled
        return callback(false); 
      }

      // launch the next INVITE
      debug('sending INVITE to %s', uri) ;
      self.createUacDialog( uri, opts, function(err, uacDialog ) {
        if( err ) { 
          //non-success: crank back to the next uri if we have one
          finalUacFail = err ;
          debug('got failure %d', err.status) ;

          return callback(false) ; 
        }

        // success - we're done
        debug('got success!') ;
        finalUacSuccess = uacDialog ;

        // need to handle a very quick hangup coming before we establish the uas dialog
        uacDialog.on('destroy', function( msg ) {
          debug('Srf#createBackToBackDialogs: got a BYE on B leg before A leg has ACK\'ed') ;
          uacBye = msg ;
        }) ;
        callback(true) ;
      }, 
      function( provisionalRes ) {
        if( provisionalRes.status > 100 ) {
          debug('Srf#createBackToBackDialogs: received a provisional response %d', provisionalRes.status) ;
          var opts = {} ;
          if( provisionalRes.body ) { 
            opts.body = localSdpA || provisionalRes.body ; 
          }
          res.send(provisionalRes.status, provisionalRes.reason, opts) ;

          if( onProvisional ) { 
            onProvisional( provisionalRes ) ;
          }
          // we're committed to this uac now
          receivedProvisional = true ;
        }
      }).then( function( uacInvite ) {
        req.on('cancel', function() {
          debug('Srf#createBackToBackDialogs: received CANCEL as uas; sending CANCEL as uac') ;
          canceled = true ;
          finalUacFail = new SipError( 487, 'Request Terminated') ;
          uacInvite.cancel() ;
        }) ;
      }) ;
    }, 
    function( successUri) {
      if( typeof successUri === 'undefined') {
        // all failed, send the final failure response back (TODO: should we be tracking the "best" failure to return?)
        res.send(finalUacFail.status, finalUacFail.reason) ;
        return cb( finalUacFail ) ;
      }

      // success 
      opts = {} ;
      opts.localSdp = localSdpA || finalUacSuccess.remote.sdp ;

      self.createUasDialog( req, res, opts, function( err, uasDialog ) {
        if( err ) { 
          return cb(err); 
        }

        finalUacSuccess.removeAllListeners('destroy') ;

        // if B leg has already hung up, emit destroy event after caller has a chance to set up handlers
        if( uacBye ) {
          setImmediate( function() {
            finalUacSuccess.emit( 'destroy', uacBye ) ;
          }) ;
        }

        cb( null, uasDialog, finalUacSuccess ) ;
      }) ;
    }
  ) ;
} ;

/**
 * This callback provides the response to createBackToBackDialog request.
 * @callback Srf~b2bDialogCreationCallback
 * @param {Error} err   error returned on non-success
 * @param {Dialog} uasDialog - User Agent Server dialog (i.e., "A" leg)
 * @param {Dialog} uacDialog - User Agent Client dialog (i.e., "B" leg) 
 */

/**
 * This callback provides the provisional responses received on the UAS leg when issuing a createBackToBackDialog request.
 * @callback Srf~provisionalResponseCallback
 * @param  {Response}   res  - drachtio Response object
 */

/**
 * proxy an incoming request
 * @param  {Request}   req - drachtio request object representing an incoming SIP request
 * @param {String|Array} destination -  an IP address[:port], or list of same, to proxy the request to
 * @param  {Srf~proxyOptions}   [opts] - configuration options for the proxy operation
 * @param  {Srf~proxyCallback} [callback] - invoked when proxy operation is completed
 */
Srf.prototype.proxyRequest = function( req, destination, opts, callback ) {
  assert(typeof destination === 'string' || _.isArray(destination), '\'destination\' is required and must be a string or an array of strings') ;

  if( typeof opts === 'function') {
    callback = opts ;
    opts = {} ;
  }
  opts.destination = destination ;

  return req.proxy( opts, callback ) ;
} ;

Srf.prototype.addDialog = function( dialog ) {
  this.dialogs[dialog.id] = dialog ;
  debug('Srf#addDialog: dialog count is now %d ', _.keys( this.dialogs ).length ) ;
} ;
Srf.prototype.removeDialog = function( dialog ) {
  delete this.dialogs[dialog.id] ;
  debug('Srf#removeDialog: dialog count is now %d', _.keys( this.dialogs ).length ) ;
} ;
/**
 * This callback provides the response to the proxy method
 * @callback Srf~proxyCallback
 * @param {Error} err   error returned on non-success
 * @param {Srf~proxyResults} results - description of the result of the proxy operation
 */


/**
 * Arguments provided when creating a UAS dialog
 * @typedef {Object} Srf~uasOptions
 * @property {Object=} headers SIP headers to include on the SIP response to the INVITE
 * @property {string} localSdp the local session description protocol to include in the SIP response
 */

/**
 * Arguments provided when creating a UAC dialog
 * @typedef {Object} Srf~uacOptions
 * @property {Object=} [headers] SIP headers to include on the SIP INVITE request
 * @property {string} localSdp the local session description protocol to include in the SIP INVITE request
 * @property {RequestUri=} [uri] request uri to send to 
 */

/**
 * Arguments provided when creating a B2BUA
 * @typedef {Object} Srf~b2bOptions
 * @property {Object} [headers] SIP headers to include on the SIP INVITE request
 * @property {string} [localSdpA] the local session description protocol to offer in the response to the SIP INVITE request on the A leg
 * @property {string} [localSdpB] the local session description protocol to offer in the SIP INVITE request on the B leg
 * @property {Srf~provisionalCallback} [onProvisional] a callback that is invoked when a provisional response is received from the B leg
 * @property {string} provisionalTimeout - timeout after which to attempt next uri in the destination array (e.g '1s')
 */

/**
 * Arguments provided when proxying an incoming request
 * @typedef {Object} Srf~proxyOptions
 * @property {String} [forking=sequential] - when multiple destinations are provided, this option governs whether they are attempted sequentially or in parallel.  Valid values are 'sequential' or 'parallel'
 * @property {Boolean} [remainInDialog=false] - if true, add Record-Route header and remain in the SIP dialog (i.e. receiving futher SIP messaging for the dialog, including the terminating BYE request)
 * @property {String} [provisionalTimeout] - timeout after which to attempt the next destination if no 100 Trying response has been received.  Examples of valid syntax for this property is '1500ms', or '2s'
 * @property {String} [finalTimeout] - timeout, in milliseconds, after which to cancel the current request and attempt the next destination if no final response has been received.  Syntax is the same as for the provisionalTimeout property.
 * @property {Boolean} [followRedirects=false] - if true, handle 3XX redirect responses by generating a new request as per the Contact header; otherwise, proxy the 3XX response back upstream without generating a new response
 */

/**
 * Arguments provided when proxying an incoming request
 * @typedef {Object} Srf~proxyResults
 * @property {Boolean} connected - indicates whether the request was successfully connected to one of the destinations
 * @property {Srf~proxyResponse[]} responses - array of responses received from destination endpoints
*/
/**
 * Detailed information describing the responses received from one proxy destination
 * @typedef {Object} Srf~proxyResponse
 * @property {string} address - destination SIP signaling address that generated the response
 * @property {Number} port - destination SIP signaling port that generated the response
 * @property {Srf~proxyResponseMsg[]} msgs - array of SIP messages received from the destination in response to the proxy request
 * */
/**
 * Detailed information describing a single SIP response message received from one specific proxy attempt
 * @typedef {Object} Srf~proxyResponseMsg
 * @property {String} time - the time (UTC) at which the SIP stack received the response
 * @property {Number} status - the SIP status of the response
 * @property {Object} msg - the full SIP message received
*/
/** send a SIP request outside of a dialog
*   @name Srf#request
*   @method
*   @param  {string} uri - sip request-uri to send request to
*   @param {Srf~requestOptions} [opts] - configuration options 
*   @param  {Srf~requestCallback} [cb] - callback invoked when operation has completed
*/
/**
 * Arguments provided when sending a request outside of a dialog
 * @typedef {Object} Srf~requestOptions
 * @property {String} method - SIP method to send (lower-case)
 * @property {Object} [headers] - SIP headers to apply to the outbound request
 * @property {String} [body] - body to send with the SIP request
*/
/**
 * This callback provides the response to the request method
 * @callback Srf~requestCallback
 * @param {Error} err   error returned on non-success
 * @param {Request} req - drachtio request that was sent. Note: you will tyically want to call "req.on('response', function(res){..}"" in order to handle responses from the far end.
 */
/** connect to drachtio server
*   @name Srf#connect
*   @method
*   @param  {string} [host='localhost'] - address drachtio server is listening on for client connections
*   @param  {Number} [port=9022] - address drachtio server is listening on for client connections
*   @param  {String} secret - shared secret used to authenticate connections
*   @param  {Srf~connectCallback} [cb] - callback invoked when operation has completed successfully
*/
/**
 * This callback provides the response to the connect method
 * @callback Srf~connectCallback
 * @param {String} hostport - the SIP address[:port] drachtio server is listening on for incoming SIP messages
 */
/**
 * a <code>connect</code> event is emitted by an Srf instance when a connect method completes with either success or failure
 * @event Srf#connect
 * @param {Object} err - error encountered when attempting to connect
 * @param {String} hostport - the SIP address[:port] drachtio server is listening on for incoming SIP messages
 */
/**
 * a <code>cdr:attempt</code> event is emitted by an Srf instance when a call attempt has been received (inbound) or initiated (outbound)
 * @event Srf#cdr:attempt
 * @param {String} source - 'network'|'application', depending on whether the INVITE is inbound (received), or outbound (sent), respectively
 * @param {String} time - the time (UTC) recorded by the SIP stack corresponding to the attempt
 * @param {Object} msg - the actual message that was sent or received
 */
/**
 * a <code>cdr:start</code> event is emitted by an Srf instance when a call attempt has been connected successfully
 * @event Srf#cdr:start
 * @param {String} source - 'network'|'application', depending on whether the INVITE is inbound (received), or outbound (sent), respectively
 * @param {String} time - the time (UTC) recorded by the SIP stack corresponding to the attempt
 * @param {String} role - 'uac'|'uas'|'uac-proxy'|'uas-proxy' indicating whether the application is acting as a user agent client, user agent server, proxy (sending message), or proxy (receiving message) for this cdr
 * @param {Object} msg - the actual message that was sent or received
 */
/**
 * a <code>cdr:stop</code> event is emitted by an Srf instance when a connected call has ended
 * @event Srf#cdr:stop
 * @param {String} source - 'network'|'application', depending on whether the INVITE is inbound (received), or outbound (sent), respectively
 * @param {String} time - the time (UTC) recorded by the SIP stack corresponding to the attempt
 * @param {String} reason - the reason the call was ended
 * @param {Object} msg - the actual message that was sent or received
 */


delegate(Srf.prototype, '_app')
  .method('connect')
  .method('on')
  .method('use')
  .method('request') ;

methods.forEach( function(method) {
  delegate(Srf.prototype, '_app').method(method.toLowerCase()) ;
}) ;

