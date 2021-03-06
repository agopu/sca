'use strict';

//node
var fs = require('fs');

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var path = require('path');
var multiparty = require('multiparty');
var mime = require('mime');
var modeString = require('fs-mode-to-string');
var request = require('request');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
var common = require('../common');
var resource_lib = require('../resource');
var transfer = require('../transfer');

function mask_enc(resource) {
    //mask all config parameters that starts with enc_
    for(var k in resource.config) {
        if(k.indexOf("enc_") === 0) {
            resource.config[k] = true;
        }
    }
    return resource;
}

/**
 * @api {get} /resource         Get resource registrations
 * @apiParam {Object} where     Optional Mongo query to perform
 * @apiDescription Returns all resource registration detail that belongs to a user (doesn't include resource with group access)
 * @apiGroup Resource
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object[]} resources        Resource detail
 */
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var where = {};
    if(req.query.where) where = JSON.parse(req.query.where);
    where.user_id = req.user.sub;

    db.Resource.find(where)
    .lean()
    .exec(function(err, resources) {
        if(err) return next(err);
        resources.forEach(mask_enc);
            
        //add / remove a few more things
        resources.forEach(function(resource) {
            resource.detail = config.resources[resource.resource_id];
            resource.salts = undefined;
        });
        res.json(resources);
    });
});

/* finds the intersection of 
 * two arrays in a simple fashion.  
 *
 * PARAMS
 *  a - first array, must already be sorted
 *  b - second array, must already be sorted
 *
 * NOTES
 *
 *  Should have O(n) operations, where n is 
 *    n = MIN(a.length(), b.length())
 */
function intersect_safe(a, b)
{
  var ai=0, bi=0;
  var result = [];

  while( ai < a.length && bi < b.length )
  {
     if      (a[ai] < b[bi] ){ ai++; }
     else if (a[ai] > b[bi] ){ bi++; }
     else /* they're equal */
     {
       result.push(a[ai]);
       ai++;
       bi++;
     }
  }

  return result;
}

//return true if user hass access
function check_access(user, resource) {
    if(resource.user_id == user.sub) return true;
    if(resource.gids && user.gids) {
        var inter = intersect_safe(resource.gids, user.gids);
        if(inter.length) return true;
    }
    return false;
}

//use sftp/readir to list file entries
router.get('/ls', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource_id = req.query.resource_id;
    var _path = req.query.path; //TODO.. validate?
    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        //if(resource.user_id != req.user.sub) return res.status(401).end(); 
        if(!check_access(req.user, resource)) return res.status(401).end(); 

        //append workdir if relateive
        if(_path[0] != "/") _path = common.getworkdir(_path, resource);

        logger.debug("getting ssh connection");
        common.get_sftp_connection(resource, function(err, sftp) {
            if(err) return next(err);
            logger.debug("reading directory:"+_path);
            var t = setTimeout(function() {
                res.status(500).json({message: "Timed out while reading directory"});
                t = null;
            }, 4000);
            sftp.readdir(_path, function(err, files) {
                if(t) clearTimeout(t); 
                else return; //timeout called
                if(err) return next(err);
                files.forEach(function(file) {
                    file.attrs.mode_string = modeString(file.attrs.mode);
                });
                res.json({files: files});
            });
        });
    });
});

//http://stackoverflow.com/questions/770523/escaping-strings-in-javascript
String.prototype.addSlashes = function() 
{ 
   //no need to do (str+'') anymore because 'this' can only be a string
   return this.replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0');
} 

router.delete('/file', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource_id = req.query.resource_id;
    var _path = req.query.path; //TODO.. validate?
    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        //if(resource.user_id != req.user.sub) return res.status(401).end(); 
        if(!check_access(req.user, resource)) return res.status(401).end(); 

        //append workdir if relateive
        if(_path[0] != "/") _path = common.getworkdir(_path, resource);

        logger.debug("getting ssh connection");
        common.get_ssh_connection(resource, function(err, conn) {
            if(err) return next(err);
            console.log("rm \""+_path.addSlashes()+"\"");
            conn.exec("rm \""+_path.addSlashes()+"\"", function(err, stream) {
                if(err) return next(err);
                stream.on('end', function() {
                    res.json({msg: "file removed"});
                });
            }) 
        });
    });
});

//return a best resource for a given purpose / criteria (TODO..)
//TODO should sca be the only one who should be query the *best* resource?
//currently used by file upload service to pick which resource to upload files
//also used by sca-cli backup to pick do file upload also
//also used by sca-wf-freesurfer process controller to check to make sure user has a place to submit
router.get('/best', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    logger.debug("choosing best resource for service:"+req.query.service);

    /*
    //I first need a bit more information about the user (for gids)
    console.log("loading user info from auth service");
    console.log(config.api.auth);
    request.get({
        url: config.api.auth+"/user/groups/"+req.user.sub,
        json: true,
        //qs: { where: JSON.stringify({id: req.user.sub}), gids: true },
        headers: { 'Authorization': 'Bearer '+config.sca.jwt }
    }, function(err, res, users) {
        if(err) return next(err);
        console.log(res.statusCode);
        console.log(res.statusMessage);
        console.dir(users);
    });
    */

    resource_lib.select(req.user, {
        service: req.query.service,  //service that resource must provide
        //other_service_ids: req.query.other_service_ids, //TODO -- helps to pick a better ID
    }, function(err, resource, score) {
        if(err) return next(err);
        if(!resource) return res.json({nomatch: true});
        var resource_detail = config.resources[resource.resource_id];
        var ret = {
            score: score,
            resource: mask_enc(resource),
            detail: resource_detail,
            workdir: common.getworkdir(null, resource),
        };
        res.json(ret);
    });
});

//TODO - should use sftp/mkdir ?
function mkdirp(conn, dir, cb) {
    //var dir = path.dirname(_path);
    //logger.debug("mkdir -p "+dir);
    conn.exec("mkdir -p "+dir, {}, function(err, stream) {
        if(err) return cb(err);
        stream.on('close', function(code, signal) {
            logger.log("mkdir -p done");
            cb();
        });
    });
}


//handle file upload request via multipart form
//takes resource_id and path via headers (mkdirp path if it doesn't exist)
//TODO - deprecate this and use the streaming version below..
router.post('/upload', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var form = new multiparty.Form({autoFields: true});
    //var resource_id = req.headers.resource_id;
    //var _path = req.headers.path;

    var fields = {};
    form.on('field', function(name, value) {
        //TODO validate?
        fields[name] = value;
        console.log("got field:"+name+" "+value);
    });

    form.on('part', function(part) {
        if(!fields.resource_id || !fields.path) return next("resource_id or path parameters missing");
        part.on('error', next);

        //part is received.. find resource
        db.Resource.findById(fields.resource_id, function(err, resource) {
            if(err) return next(err);
            if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
            //if(resource.user_id != req.user.sub) return res.status(401).end(); 
            if(!check_access(req.user, resource)) return res.status(401).end(); 
            common.get_ssh_connection(resource, function(err, conn) {
                if(err) return next(err);
                //logger.debug("calling mkdirp");
                
                //append workdir if relateive (TODO should use node path module?)
                if(fields.path[0] != "/") fields.path = common.getworkdir(fields.path, resource);
                logger.debug("mkdirp: "+fields.path);
                mkdirp(conn, fields.path, function(err) {
                    if(err) return next(err);
                    conn.sftp(function(err, sftp) {
                        if(err) return next(err);
                        //var escaped_filename = part.filename.replace(/"/g, '\\"');
                        //var _path = fields.path+"/"+escaped_filename;
                        var _path = fields.path+"/"+part.filename;

                        logger.debug("streaming file to "+_path);
                        var stream = sftp.createWriteStream(_path);
                        part.pipe(stream).on('close', function() {
                            logger.debug("streaming closed");
                            sftp.stat(_path, function(err, stat) {
                                sftp.end();
                                if(err) return next(err);
                                res.json({file: {filename: part.filename, attrs: stat}});
                            });
                        });
                    });
                });
            });
        });
    });
    form.parse(req);
});

//simpler streaming 
router.post('/upload/:resourceid/:path', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.resourceid;
    var _path = (new Buffer(req.params.path, 'base64').toString('ascii'));
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        //if(resource.user_id != req.user.sub) return res.status(401).end();
        if(!check_access(req.user, resource)) return res.status(401).end(); 
        common.get_ssh_connection(resource, function(err, conn) {
            if(err) return next(err);
            var fullpath = common.getworkdir(_path, resource);
            logger.debug("mkdirp "+path.dirname(fullpath));
            mkdirp(conn, path.dirname(fullpath), function(err) {
                if(err) return next(err);
                conn.sftp(function(err, sftp) {
                    if(err) return next(err);
                    logger.debug("streaming file to "+_path);
                    req.pipe(sftp.createWriteStream(fullpath))
                    .on('close', function() {
                        logger.debug("streaming closed");
                        sftp.stat(fullpath, function(err, stat) {
                            sftp.end();
                            if(err) return next(err);
                            res.json({filename: path.basename(fullpath), attrs: stat});
                        });
                    });
                });
            });
        });
    });
});

/* I believe noone uses this 
router.post('/exec', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource_id = req.body.resource_id;
    var cmd = req.body.cmd;
    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        if(resource.user_id != req.user.sub) return res.status(401).end(); 
        common.get_ssh_connection(resource, function(err, conn) {
            if(err) return next (err);
            var workdir = common.getworkdir("", resource);
            conn.exec("cd "+workdir+" && "+cmd, function(err, stream) {
                if(err) return cb(err);
                stream.on('data', function(data) {
                    res.write(data);
                });
                stream.on('end', function(data) {
                    res.end();
                    //conn.end();
                });
            });
        });
    });
});
*/

//currently used by sca-cli cp 
//deprecated
//you can just submit a task that requires other taskdir
/*
router.post('/transfer', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var task_id = req.body.task_id;
    var dest_resource_id = req.body.dest_resource_id;

    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).json({message: "couldn't find the task specified"});
        if(task.user_id != req.user.sub) return res.status(401).end(); 
        db.Resource.findById(task.resource_id, function(err, source_resource) {
            if(err) return next(err);
            //if(!source_resource) return res.status(404).json({message: "couldn't find the source resource specified in a task"});
            //if(source_resource.user_id != req.user.sub) return res.status(401).end(); 
            db.Resource.findById(dest_resource_id, function(err, dest_resource) {
                if(err) return next(err);
                if(!dest_resource) return res.status(404).json({message: "couldn't find the dest resource specified"});
                if(dest_resource.user_id != req.user.sub) return res.status(401).end(); 

                var source_path = common.gettaskdir(task.instance_id, task_id, source_resource);
                var dest_path = common.gettaskdir(task.instance_id, task_id, dest_resource);

                //now start rsync
                transfer.rsync_resource(source_resource, dest_resource, source_path, dest_path, function(err) {
                    if(err) throw err; //TODO - don't throw here.. mark this transfer as failed (no such collection yet)
                }, function(progress) {
                    //event stream?
                });
                res.json({message: "data transfer requested.."});
            });
        });
    });
});
*/

//this API allows user to download any files under user's workflow directory
//TODO - since I can't let <a> pass jwt token via header, I have to expose it via URL.
//doing so increases the chance of user misusing the token, but unless I use HTML5 File API
//there isn't a good way to let user download files..
//getToken() below allows me to check jwt token via "at" query.
router.get('/download', jwt({
    secret: config.sca.auth_pubkey,
    getToken: function(req) { 
        //load token from req.headers as well as query.at
        if(req.query.at) return req.query.at; 
        if(req.headers.authorization) {
            var auth_head = req.headers.authorization;
            if(auth_head.indexOf("Bearer") === 0) return auth_head.substr(7);
        }
        return null;
    }
}), function(req, res, next) {
    var resource_id = req.query.r;
    var _path = req.query.p;
    
    //TODO - this validation isn't good enough.. (use can use escape, etc..)
    //if(~_path.indexOf("..")) return next("invalid path");

    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        //if(resource.user_id != req.user.sub) return res.status(401).end(); 
        if(!check_access(req.user, resource)) return res.status(401).end(); 
        
        //append workdir if relateive
        if(_path[0] != "/") _path = common.getworkdir(_path, resource);

        logger.debug("downloading: "+_path);
        logger.debug("from resource:"+resource._id);

        common.get_sftp_connection(resource, function(err, sftp) {
            if(err) return next(err);
            sftp.stat(_path, function(err, stat) {
                if(err) return next(err);
                console.log(mime.lookup(_path));
                //res.setHeader('Content-disposition', 'attachment; filename='+path.basename(_path));
                res.setHeader('Content-disposition', 'filename='+path.basename(_path));
                res.setHeader('Content-Length', stat.size);
                res.setHeader('Content-Type', mime.lookup(_path));
                var stream = sftp.createReadStream(_path);
                stream.pipe(res);               
                /*
                stream.on('close', function() {
                    //logger.debug("download streaming ended");
                    sftp.close();
                });
                */
            });
            /*
            sftp.on('error', function(err) {
                console.dir(err);
                res.status(500).json(err);
            });
            */
        });
    });
});

/**
 * @api {put} /resource/test/:resource_id Test resource 
 * @apiName TestResource
 * @apiGroup Resource
 *
 * @apiParam {String} resource_id Resource ID
 * @apiDescription Test resource connectivity and availability. Store status on status/status_msg fields of the resource entry
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "status": "ok"
 *     }
 *
 * @apiErrorExample {json} Error-Response:
 *     HTTP/1.1 500 OK
 *     {
 *         "message": "SSH connection failed"
 *     }
 *
 */
router.put('/test/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        //if(resource.user_id != req.user.sub) return res.status(401).end();
        if(!check_access(req.user, resource)) return res.status(401).end(); 
        resource_lib.check(resource, function(err, ret) {
            if(err) return next(err);
            res.json(ret);
        });
    });
});

/**
 * @api {put} /resource/:id Update resource instance
 * @apiName UpdateResource
 * @apiGroup Resource
 *
 * @apiParam {String} id Resource ID
 * @apiDescription Update the resource instance (only the resource that user owns)
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccess {Object} Resource Object
 *
 */
router.put('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(resource.user_id != req.user.sub) return res.status(401).end();

        //need to decrypt first so that I can preserve previous values
        common.decrypt_resource(resource);
        
        //keep old value if enc_ fields are set to true
        for(var k in req.body.config) {
            if(k.indexOf("enc_") === 0) {
                var v = req.body.config[k];
                if(v === true) {
                    req.body.config[k] = resource.config[k];
                }
            }
        }

        //decrypt again and save
        common.encrypt_resource(req.body);
        db.Resource.update({_id: id}, { $set: req.body }, {new: true}, function(err) {
            if(err) return next(err);
            mask_enc(req.body);
            res.json(req.body);
        });
    });
});

/**
 * @api {post} /resource Register new resource
 * @apiName NewResource
 * @apiGroup Resource
 *
 * @apiDescription Just create a DB entry for a new resource - it doesn't test resource / install keys, etc..
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     { __v: 0,
 *      user_id: '9',
 *      gids: [1,2,3],
 *      type: 'pbs',
 *      resource_id: 'karst',
 *      name: 'use foo\'s karst account',
 *      config: 
 *       { ssh_public: 'my public key',
 *         enc_ssh_private: true,
 *         username: 'hayashis' },
 *      _id: '5758759710168abc3562bf01',
 *      update_date: '2016-06-08T19:44:23.205Z',
 *      create_date: '2016-06-08T19:44:23.204Z',
 *      active: true }
 *
 */
router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource = new db.Resource(req.body);
    resource.user_id = req.user.sub;
    common.encrypt_resource(resource);
    resource.save(function(err, _resource) {
        if(err) return next(err);
        res.json(mask_enc(_resource));
    });
});

/**
 * @api {delete} /resource/:id Remove resource
 * @apiName RemoveResource
 * @apiGroup Resource
 *
 * @apiParam {String} id Resource ID
 * @apiDescription Remove resource instance
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccess {String} 'ok'
 *
 */
router.delete('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end("couldn't find such resource");
        if(resource.user_id != req.user.sub) return res.status(401).end("you don't own this resource");
        resource.remove(function(err) {
            if(err) return next(err);
            console.log("done removing");
            res.json({status: 'ok'});
        });
    });

    /*
    var resource = new db.Resource(req.body);
    resource.user_id = req.user.sub;
    resource.save(function(err, _resource) {
        if(err) return next(err);
        res.json({status: 'ok'});
    });
    */
});

/**
 * @api {get} /resource/gensshkey Generate ssh key pair
 * @apiName GENSSHKEYResource
 * @apiGroup Resource
 *
 * @apiDescription used by resource editor to setup new resource
 *      jwt is optional.. since it doesn't really store this anywhere (should I?)
 *      kdinstaller uses this to generate key (and scott's snapshot tool)
 * 
 * //@apiHeader {String} [authorization] A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     { pubkey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDDxtMlosV+/5CutlW3YIO4ZomH6S0+3VmDlAAYvBXHD+ut4faGAZ4XuumfJyg6EAu8TbUo+Qj6+pLuYLcjqxl2fzI6om2SFh9UeXkm1P0flmgHrmXnUJNnsnyen/knJtWltwDAZZOLj0VcfkPaJX7sOSp9l/8W1+7Qb05jl+lzNKucpe4qInh+gBymcgZtMudtmurEuqt2eVV7W067xJ7P30PAZhZa7OwXcQrqcbVlA1V7yk1V92O7Qt8QTlLCbszE/xx0cTEBiSkmkvEG2ztQQl2Uqi+lAIEm389quVPJqjDEzaMipZ1X5xgfnyDtBq0t/SUGZ8d0Ki1H0jmU7H//',
 *       key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEAw8 ... CeSZ6sKiQmE46Yh4/zyRD4JgW4CY=\n-----END RSA PRIVATE KEY-----' }
 *
 */
router.get('/gensshkey', jwt({secret: config.sca.auth_pubkey, credentialsRequired: false}), function(req, res, next) {
    common.ssh_keygen(function(err, out){
        if(err) return next(err);
        res.json(out);
    });
});

router.post('/installsshkey', function(req, res, next) {
    var username = req.body.username;
    var password = req.body.password;
    var host = req.body.host;
    var pubkey = req.body.pubkey;
    var comment = req.body.comment;
    common.install_sshkey(username, password, host, pubkey, comment, function(err) {
        if(err) return next(err);
        res.json({message: 'ok'});
    });
});

/*
router.post('/resetsshkeys/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(resource.user_id != req.user.sub) return res.status(401).end();
        common.ssh_keygen(function(err, out){
            if(err) next(err);
            var resource = {
                config: {
                    ssh_public: out.pubkey,
                    enc_ssh_private: out.key,
                }
            }
            common.encrypt_resource(resource);
            db.Resource.update({_id: id}, { $set: resource }, {new: true}, function(err) {
                if(err) return next(err);
                res.json({ssh_public: resource.config.ssh_public, resource: resource});
            });
        });
    });
}); 
*/

module.exports = router;

